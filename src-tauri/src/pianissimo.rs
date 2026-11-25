//! Pianissimo (Klang AI) – svensk taligenkänning via `transcribe.cpp` (ggml).
//!
//! Använder Klang AI:s officiella GGUF-modell (`KlangAI/pianissimo-sv-gguf`, `Q8_0`, CC BY 4.0)
//! med GPU-acceleration via Vulkan (Windows: AMD/NVIDIA/Intel) eller Metal (macOS Apple Silicon),
//! samt automatisk fallback till CPU.

use anyhow::{Context, Result};
use regex::Regex;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use transcribe_cpp::{Backend, Model, ModelOptions, RunOptions, Session, SessionOptions, TimestampKind};

/// Modell-ID för Pianissimo (GGUF).
pub const ENGINE_ID: &str = "pianissimo";
pub const MODEL_DIR: &str = "pianissimo-sv-gguf";
pub const MODEL_FILE: &str = "pianissimo-sv-Q8_0.gguf";
pub const REPO: &str = "KlangAI/pianissimo-sv-gguf";
/// Fast revision så att den nedladdade filen alltid matchar kontrollsumman.
pub const REVISION: &str = "3db1f0f9e0e8a26cf367416f5238420728332874";
/// (filnamn, sha256, exakt filstorlek i byte)
pub const FILES: &[(&str, &str, u64)] = &[(
    MODEL_FILE,
    "47bf6b32ee2ae7aa284815e08043b69cd3fc332ab7b532a7e7e854cae135da91",
    739_508_384,
)];

const RATE: usize = 16_000;
/// Kör i 90-sekundersblock för jämn förloppsindikator, låg VRAM-topp och snabb avbrottsrespons.
const PASS_SAMPLES: usize = 90 * RATE;

pub fn download_url(file: &str) -> String {
    format!("https://huggingface.co/{REPO}/resolve/{REVISION}/{file}")
}

pub fn file_hash(path: &Path) -> Result<String> {
    use std::io::Read;
    let mut f = std::fs::File::open(path)?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(h.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

pub fn model_dir(models_root: &Path) -> PathBuf {
    models_root.join(MODEL_DIR)
}

pub fn is_ready(dir: &Path) -> bool {
    FILES.iter().all(|(name, _, _)| dir.join(name).is_file())
}

/// Standardantal CPU-trådar (används i CPU-läge): fysiska kärnor, högst 8.
pub fn default_threads() -> usize {
    num_cpus::get_physical().clamp(1, 8)
}

#[derive(Debug, Clone)]
pub struct PSegment {
    pub start_ms: i64,
    pub end_ms: i64,
    pub text: String,
    pub words: Vec<crate::types::WordSpan>,
}

pub struct Pianissimo {
    session: Session,
    backend_name: String,
    clean: Regex,
}

impl Pianissimo {
    /// Laddar `pianissimo-sv-Q8_0.gguf`. Med `use_gpu = true` väljs Vulkan (Windows) eller
    /// Metal (macOS) automatiskt med CPU-fallback; med `use_gpu = false` körs ren CPU.
    pub fn load(dir: &Path, use_gpu: bool, threads: usize) -> Result<Self> {
        let model_path = dir.join(MODEL_FILE);
        let mut opts = ModelOptions::default();
        opts.backend = if use_gpu {
            Backend::Auto
        } else {
            Backend::CpuAccel
        };

        let model = Model::load_with(&model_path, &opts)
            .with_context(|| format!("Kunde inte ladda {}", model_path.display()))?;
        let backend_name = model.backend();

        let mut sess_opts = SessionOptions::default();
        sess_opts.n_threads = threads.clamp(1, 16) as i32;
        let session = model
            .session_with(&sess_opts)
            .context("Kunde inte skapa transkriberingssession")?;

        Ok(Self {
            session,
            backend_name,
            clean: Regex::new(r"\A\s|\s\B|(\s)\b")?,
        })
    }

    /// Namn på aktiv beräknings-backend (t.ex. `"Vulkan"`, `"Metal"`, `"CPU"`).
    pub fn backend_name(&self) -> &str {
        &self.backend_name
    }

    fn clean_text(&self, s: &str) -> String {
        self.clean.replace_all(s.trim(), "$1").trim().to_string()
    }

    /// Transkribera 16 kHz mono f32-ljud med progress (0..=100) och avbrottskontroll.
    pub fn transcribe(
        &mut self,
        samples: &[f32],
        cancel: &AtomicBool,
        progress: impl Fn(i32),
    ) -> Result<Vec<PSegment>> {
        let mut out = Vec::new();
        if samples.is_empty() {
            return Ok(out);
        }

        let mut run_opts = RunOptions::default();
        run_opts.language = Some("sv".to_string());
        // Begär ordnivå-tidsstämplar så vi kan dela upp i meningssegment (likt v0.1.0),
        // eftersom transcribe.cpp annars returnerar ett enda stort segment per 90s-block.
        run_opts.timestamps = TimestampKind::Word;

        let mut begin = 0usize;
        while begin < samples.len() {
            if cancel.load(Ordering::Relaxed) {
                break;
            }
            let end = (begin + PASS_SAMPLES).min(samples.len());
            let slice = &samples[begin..end];
            let pass_offset_ms = (begin as i64 * 1000) / RATE as i64;
            let pass_dur_ms = (slice.len() as i64 * 1000) / RATE as i64;

            let transcript = self
                .session
                .run(slice, &run_opts)
                .context("Fel vid transkribering i transcribe.cpp")?;

            if !transcript.words.is_empty() {
                out.extend(self.group_words(&transcript.words, pass_offset_ms));
            } else if !transcript.segments.is_empty() {
                for seg in transcript.segments {
                    let text = self.clean_text(&seg.text);
                    if !text.is_empty() {
                        out.push(PSegment {
                            start_ms: pass_offset_ms + seg.t0_ms.max(0),
                            end_ms: pass_offset_ms + seg.t1_ms.max(seg.t0_ms.max(0)),
                            text,
                            words: Vec::new(),
                        });
                    }
                }
            } else {
                let text = self.clean_text(&transcript.text);
                if !text.is_empty() {
                    out.push(PSegment {
                        start_ms: pass_offset_ms,
                        end_ms: pass_offset_ms + pass_dur_ms,
                        text,
                        words: Vec::new(),
                    });
                }
            }

            progress(((end as f64 / samples.len() as f64) * 100.0) as i32);
            begin = end;
        }

        Ok(out)
    }

    fn group_words(&self, words: &[transcribe_cpp::Word], offset_ms: i64) -> Vec<PSegment> {
        use crate::types::WordSpan;

        let mut result = Vec::new();
        let mut cur: Option<(i64, i64, String, Vec<WordSpan>)> = None;

        for w in words {
            let start = offset_ms + w.t0_ms.max(0);
            let end = offset_ms + w.t1_ms.max(w.t0_ms.max(0));
            let span = WordSpan {
                start_ms: start,
                end_ms: end,
                text: w.text.clone(),
            };
            if let Some((cs, ce, ct, mut cw)) = cur.take() {
                let gap_ms = start - ce;
                let too_long = (end - cs) > 15_000;
                // 800 ms paus ger skarpare replikskiften (särskilt vid hälsningar i början av möten)
                if gap_ms > 800 || too_long {
                    let cleaned = self.clean_text(&ct);
                    if !cleaned.is_empty() {
                        result.push(PSegment {
                            start_ms: cs,
                            end_ms: ce,
                            text: cleaned,
                            words: cw,
                        });
                    }
                    cur = Some((start, end, w.text.clone(), vec![span]));
                } else {
                    let mut combined = ct;
                    if !combined.ends_with(' ') && !w.text.starts_with(' ') {
                        combined.push(' ');
                    }
                    combined.push_str(&w.text);
                    cw.push(span);
                    cur = Some((cs, end, combined, cw));
                }
            } else {
                cur = Some((start, end, w.text.clone(), vec![span]));
            }

            if let Some((cs, ce, ct, cw)) = cur.take() {
                if ct.trim_end().ends_with(['.', '!', '?']) {
                    let cleaned = self.clean_text(&ct);
                    if !cleaned.is_empty() {
                        result.push(PSegment {
                            start_ms: cs,
                            end_ms: ce,
                            text: cleaned,
                            words: cw,
                        });
                    }
                } else {
                    cur = Some((cs, ce, ct, cw));
                }
            }
        }

        if let Some((cs, ce, ct, cw)) = cur {
            let cleaned = self.clean_text(&ct);
            if !cleaned.is_empty() {
                result.push(PSegment {
                    start_ms: cs,
                    end_ms: ce,
                    text: cleaned,
                    words: cw,
                });
            }
        }

        result
    }
}

impl crate::engine::Engine for Pianissimo {
    fn transcribe_chunk(
        &mut self,
        samples: &[f32],
        offset_ms: i64,
        _prev_text: Option<&str>,
        cancel: &AtomicBool,
        on_progress: &(dyn Fn(i32) + Sync),
    ) -> std::result::Result<Vec<crate::types::TranscriptSegment>, String> {
        let segs = self
            .transcribe(samples, cancel, |p| on_progress(p))
            .map_err(|e| format!("Transkribering med Pianissimo misslyckades: {e}"))?;
        Ok(segs
            .into_iter()
            .map(|s| crate::types::TranscriptSegment {
                start_ms: s.start_ms + offset_ms,
                end_ms: s.end_ms + offset_ms,
                text: s.text,
                tokens: Vec::new(),
                speaker_id: None,
                words: s
                    .words
                    .into_iter()
                    .map(|w| crate::types::WordSpan {
                        start_ms: w.start_ms + offset_ms,
                        end_ms: w.end_ms + offset_ms,
                        text: w.text,
                    })
                    .collect(),
            })
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clean_text_removes_space_before_punctuation() {
        let re = Regex::new(r"\A\s|\s\B|(\s)\b").unwrap();
        assert_eq!(re.replace_all(" Åsa är här .", "$1"), "Åsa är här.");
    }

    #[test]
    fn download_url_points_to_pinned_gguf_revision() {
        let url = download_url(MODEL_FILE);
        assert!(url.contains("KlangAI/pianissimo-sv-gguf"));
        assert!(url.contains(REVISION));
        assert!(url.ends_with("pianissimo-sv-Q8_0.gguf"));
    }
}
