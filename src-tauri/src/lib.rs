// Transkerat — 100 % lokal svensk transkribering (Pianissimo) + maskering/avmaskering (Maskera Lager 1 & 2)

use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_dialog::DialogExt;
use tokenizers::Tokenizer;

mod audio;
mod crashguard;
mod decode;
mod diarization;
mod engine;
mod logging;
mod models;
mod ner;
mod pianissimo;
mod regex_rules;
mod roles;
mod session;
mod types;
mod vocabulary;

#[cfg(target_os = "windows")]
mod application_loopback;

use audio::AudioRecorder;
use decode::StreamingDecoder;
pub(crate) use logging::log_line;
use ner::{Match, NerModel};
use regex_rules::{merge_regex_and_ner, run_regex};
use session::default_recording_dir;
use types::*;

// Globala singletons för Svensk BERT NER (Lager 2)
static NER_SESSION: OnceLock<NerModel> = OnceLock::new();
static NER_TOKENIZER: OnceLock<Tokenizer> = OnceLock::new();

pub struct AppState {
    pub cancel_flag: Arc<AtomicBool>,
    pub audio_recorder: Mutex<AudioRecorder>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct NerModelStatus {
    installed: bool,
    loaded: bool,
}

#[derive(Clone, Serialize)]
struct NerProgress {
    chunk: usize,
    total: usize,
}

#[tauri::command]
fn cancel_transcription(state: tauri::State<AppState>) {
    state.inner().cancel_flag.store(true, Ordering::Relaxed);
}

#[tauri::command]
fn get_app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

const ALLOWED_MEDIA_EXTS: &[&str] = &[
    "mp3", "m4a", "aac", "wav", "ogg", "flac", "mp4", "webm", "mkv", "mov",
];
const MAX_TEXT_FILE_BYTES: u64 = 10 * 1024 * 1024; // 10 MB

#[tauri::command]
fn allow_asset_path(app_handle: AppHandle, path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    let ok_ext = p
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| ALLOWED_MEDIA_EXTS.contains(&e.to_ascii_lowercase().as_str()));
    if !ok_ext {
        return Err("Endast ljud- och videofiler kan öppnas i uppspelaren.".to_string());
    }
    if !p.is_file() {
        return Err(format!("Filen finns inte: {path}"));
    }
    app_handle
        .asset_protocol_scope()
        .allow_file(&p)
        .map_err(|e| format!("Kunde inte tillåta fil för uppspelning: {e}"))?;
    Ok(())
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn parse_mic_payload(request: &tauri::ipc::Request<'_>) -> Result<(Vec<f32>, u32), String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("append_mic_chunk förväntar rå binär data".to_string());
    };
    let sample_rate: u32 = request
        .headers()
        .get("x-sample-rate")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse().ok())
        .ok_or("Saknar giltig x-sample-rate")?;
    let samples = bytes
        .chunks_exact(4)
        .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
        .collect();
    Ok((samples, sample_rate))
}

#[cfg(target_os = "windows")]
#[tauri::command]
async fn append_mic_chunk(
    state: tauri::State<'_, AppState>,
    request: tauri::ipc::Request<'_>,
) -> Result<(), String> {
    let (samples, sample_rate) = parse_mic_payload(&request)?;
    let recorder = state
        .inner()
        .audio_recorder
        .lock()
        .map_err(|e| format!("Recorder-lås: {e}"))?;
    recorder.append_mic_pcm(&samples, sample_rate)
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
async fn append_mic_chunk(_request: tauri::ipc::Request<'_>) -> Result<(), String> {
    Ok(())
}

/// Transkribera ljudfil med svenska Pianissimo via transcribe.cpp (Vulkan/Metal/CPU).
#[tauri::command]
async fn transcribe_file(
    app_handle: AppHandle,
    state: tauri::State<'_, AppState>,
    file_path: String,
    identify_speakers: Option<bool>,
    use_gpu: Option<bool>,
    thread_count: Option<u32>,
) -> Result<Vec<TranscriptSegment>, String> {
    state.inner().cancel_flag.store(false, Ordering::Relaxed);
    let model_path = models::pianissimo_dir(&app_handle)?;
    if !pianissimo::is_ready(&model_path) {
        return Err("Pianissimo-modellen saknas. Ladda ned den först.".to_string());
    }
    let cancel = Arc::clone(&state.inner().cancel_flag);
    let app = app_handle.clone();
    let gpu_enabled = use_gpu.unwrap_or(true);
    let threads = thread_count
        .map(|n| (n as usize).clamp(1, 16))
        .unwrap_or_else(pianissimo::default_threads);
    let vocab_entries =
        vocabulary::active_entries(&vocabulary::load_store(&app_handle).unwrap_or_default());

    let diar_dir = if identify_speakers.unwrap_or(false) {
        let d = models::diarization_dir(&app_handle)?;
        if !diarization::is_ready(&d) {
            return Err("Talarmodellerna saknas. Ladda ned dem först.".to_string());
        }
        Some(d)
    } else {
        None
    };

    let segments = tokio::task::spawn_blocking(move || -> Result<Vec<TranscriptSegment>, String> {
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(
            || -> Result<Vec<TranscriptSegment>, String> {
                let _run_guard = crashguard::RunGuard::start(&app, pianissimo::ENGINE_ID, gpu_enabled);
                let mut dec = StreamingDecoder::open(&file_path)?;
                let mut eng = pianissimo::Pianissimo::load(&model_path, gpu_enabled, threads)
                    .map_err(|e| format!("Kunde inte starta Pianissimo: {e}"))?;
                log_line(&format!(
                    "transcribe_file: Pianissimo laddad (backend={}, use_gpu={gpu_enabled}, threads={threads})",
                    eng.backend_name()
                ));
                let _ = app.emit("engine_backend", eng.backend_name().to_string());

                let emit = |p: i32| {
                    let _ = app.emit(
                        "transcription_progress",
                        TranscriptionProgressPayload { progress: p },
                    );
                };
                emit(0);
                let mut segs = engine::run_file(&mut eng, &mut dec, &cancel, &emit)?;
                log_line(&format!(
                    "transcribe_file (Pianissimo): klar, {} segment",
                    segs.len()
                ));
                drop(eng);
                drop(dec);

                // Kör talaridentifiering (inkl. ordnivå-splittning vid talarbyte) FÖRE ordlistan
                // så att ordtidsstämplarna stämmer exakt och ordlistan rättar de slutgiltiga segmenten.
                if let Some(dir) = diar_dir {
                    if !cancel.load(Ordering::Relaxed) && !segs.is_empty() {
                        let phase =
                            |phase: &'static str, speakers: i32, message: Option<String>| {
                                let _ = app.emit(
                                    "diarization_phase",
                                    DiarizationPhasePayload {
                                        phase,
                                        speakers,
                                        percent: 0,
                                        eta_seconds: 0,
                                        message,
                                    },
                                );
                            };
                        let on_progress = |percent: i32, eta_seconds: i64| {
                            let _ = app.emit(
                                "diarization_phase",
                                DiarizationPhasePayload {
                                    phase: "progress",
                                    speakers: 0,
                                    percent,
                                    eta_seconds,
                                    message: None,
                                },
                            );
                        };
                        phase("start", 0, None);
                        log_line("diarization: startar");
                        let started = std::time::Instant::now();
                        match diarization::identify(&dir, &file_path, &mut segs, &cancel, &on_progress) {
                            Ok(n) => {
                                log_line(&format!(
                                    "diarization: {n} talare på {:.1} s ({} segment efter splittning)",
                                    started.elapsed().as_secs_f64(),
                                    segs.len()
                                ));
                                phase("done", n, None);
                            }
                            Err(e) if e == diarization::CANCELLED => {
                                log_line(&format!(
                                    "diarization: avbruten efter {:.1} s",
                                    started.elapsed().as_secs_f64()
                                ));
                                phase("cancelled", 0, None);
                            }
                            Err(e) => {
                                log_line(&format!(
                                    "diarization: misslyckades efter {:.1} s: {e}",
                                    started.elapsed().as_secs_f64()
                                ));
                                phase("failed", 0, Some(e));
                            }
                        }
                    }
                }

                if !vocab_entries.is_empty() {
                    let mut changes: Vec<vocabulary::Change> = Vec::new();
                    for seg in segs.iter_mut() {
                        let (text, c) = vocabulary::correct_text(&seg.text, &vocab_entries);
                        if !c.is_empty() {
                            seg.text = text;
                            seg.tokens.clear();
                            changes.extend(c);
                        }
                    }
                    log_line(&format!("ordlista: {} ord rättades", changes.len()));
                    let _ = app.emit("vocabulary_applied", changes);
                }
                Ok(segs)
            },
        ))
        .unwrap_or_else(|p| Err(format!("Transkriberingen kraschade: {}.", engine::panic_msg(p))))
    })
    .await
    .map_err(|e| format!("Task-fel: {e}"))??;

    let _ = app_handle.emit(
        "transcription_progress",
        TranscriptionProgressPayload { progress: 100 },
    );
    Ok(segments)
}

// ── Maskering: Lager 1 (Regex + Roll/Titel) & Lager 2 (Svensk BERT NER) ──────

#[tauri::command]
fn check_ner_model_status(app_handle: AppHandle) -> Result<NerModelStatus, String> {
    let loaded = NER_SESSION.get().is_some() && NER_TOKENIZER.get().is_some();
    let dir = models::ner_dir(&app_handle)?;
    let installed = loaded || models::ner_is_ready(&dir);
    Ok(NerModelStatus { installed, loaded })
}

#[tauri::command]
async fn ensure_ner_model(app_handle: AppHandle) -> Result<NerModelStatus, String> {
    if NER_SESSION.get().is_some() && NER_TOKENIZER.get().is_some() {
        return Ok(NerModelStatus {
            installed: true,
            loaded: true,
        });
    }

    let dir = models::ner_dir(&app_handle)?;
    if !models::ner_is_ready(&dir) {
        log_line("maskering: laddar ned KBLab Svensk BERT NER (~127 MB)");
        models::download_ner_files(&app_handle).await?;
    } else {
        let _ = app_handle.emit(
            "ner_download_progress",
            models::NerDownloadProgress {
                phase: "loading".into(),
                label: "Startar svensk maskeringsmodell…".into(),
                downloaded: 1,
                total: 1,
                progress: 100.0,
            },
        );
    }

    let model_path = dir.join("model_quantized.onnx");
    let tok_path = dir.join("tokenizer.json");

    tokio::task::spawn_blocking(move || -> Result<(), String> {
        if NER_SESSION.get().is_none() {
            let model = ner::load_model(&model_path)?;
            let _ = NER_SESSION.set(model);
        }
        if NER_TOKENIZER.get().is_none() {
            let tok = ner::load_tokenizer(&tok_path)?;
            let _ = NER_TOKENIZER.set(tok);
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("Task-fel vid laddning av NER-modell: {e}"))??;

    log_line("maskering: Svensk BERT NER redo");
    let _ = app_handle.emit(
        "ner_download_progress",
        models::NerDownloadProgress {
            phase: "ready".into(),
            label: "Maskeringsmodell redo".into(),
            downloaded: 1,
            total: 1,
            progress: 100.0,
        },
    );

    Ok(NerModelStatus {
        installed: true,
        loaded: true,
    })
}

#[tauri::command]
async fn analyze_text(
    text: String,
    entities: Vec<String>,
    threshold: f32,
    app_handle: AppHandle,
) -> Result<Vec<Match>, String> {
    const REGEX_ONLY: &[&str] = &[
        "Personnummer",
        "E-post",
        "Telefonnummer",
        "Org.nummer",
        "Konto/Giro",
        "IP-adress",
        "Kortnummer",
        "Hemlighet/Nyckel",
        "Roll/Titel",
    ];

    let ner_entities: Vec<String> = entities
        .iter()
        .filter(|e| !REGEX_ONLY.contains(&e.as_str()))
        .cloned()
        .collect();

    if !ner_entities.is_empty() && (NER_SESSION.get().is_none() || NER_TOKENIZER.get().is_none()) {
        return Err("Maskeringsmodellen (Svensk BERT NER) är inte laddad ännu.".into());
    }

    tokio::task::spawn_blocking(move || -> Result<Vec<Match>, String> {
        let regex_matches = run_regex(&text, &entities);
        if ner_entities.is_empty() {
            return Ok(regex_matches);
        }

        let model = NER_SESSION.get().ok_or("NER-modell ej laddad")?;
        let tokenizer = NER_TOKENIZER.get().ok_or("NER-tokenizer ej laddad")?;
        let ner_matches = ner::run_ner(
            &text,
            &ner_entities,
            threshold,
            model,
            tokenizer,
            |chunk, total| {
                let _ = app_handle.emit("ner_progress", NerProgress { chunk, total });
            },
        );

        Ok(merge_regex_and_ner(regex_matches, ner_matches))
    })
    .await
    .map_err(|e| format!("Task-fel vid textanalys: {e}"))?
}

// ── Inspelning & filhantering ─────────────────────────────────────────────────

#[derive(Serialize)]
struct RecordingStartResult {
    loopback_active: bool,
}

#[tauri::command]
async fn start_backend_recording(
    app_handle: AppHandle,
    state: tauri::State<'_, AppState>,
    loopback_only: bool,
    with_loopback: bool,
    recording_dir: Option<String>,
) -> Result<RecordingStartResult, String> {
    log_line(&format!(
        "start_backend_recording: loopback_only={loopback_only}, with_loopback={with_loopback}, recording_dir={recording_dir:?}"
    ));

    let base_dir = match recording_dir.as_deref() {
        Some(p) if !p.is_empty() => PathBuf::from(p),
        _ => default_recording_dir(&app_handle)?,
    };
    std::fs::create_dir_all(&base_dir)
        .map_err(|e| format!("Kunde inte skapa inspelningsmapp {}: {e}", base_dir.display()))?;

    let mut recorder = state
        .inner()
        .audio_recorder
        .lock()
        .map_err(|e| format!("Recorder-lås: {e}"))?;
    let result = recorder.start_recording(loopback_only, with_loopback, &base_dir);
    result?;
    Ok(RecordingStartResult {
        loopback_active: recorder.loopback_active,
    })
}

#[tauri::command]
async fn stop_backend_recording(state: tauri::State<'_, AppState>) -> Result<(), String> {
    let mut recorder = state
        .inner()
        .audio_recorder
        .lock()
        .map_err(|e| format!("Recorder-lås: {e}"))?;
    recorder.stop_recording()
}

#[tauri::command]
async fn save_text_file(
    app_handle: AppHandle,
    content: String,
    default_name: Option<String>,
) -> Result<(), String> {
    use tauri_plugin_dialog::FilePath;

    let file_name = default_name.unwrap_or_else(|| "transkribering.txt".to_string());
    let file_path = app_handle
        .dialog()
        .file()
        .set_title("Spara textfil")
        .set_file_name(&file_name)
        .add_filter("Textfil", &["txt"])
        .blocking_save_file();

    match file_path {
        Some(path) => {
            let path_str = match path {
                FilePath::Path(p) => p,
                _ => return Err("Ogiltigt filformat".to_string()),
            };
            fs::write(&path_str, &content).map_err(|e| format!("Kunde inte spara: {}", e))?;
            Ok(())
        }
        None => Err("cancelled".to_string()),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PickedTextFile {
    file_name: String,
    content: String,
}

fn read_picked_text_path(p: &std::path::Path) -> Result<PickedTextFile, String> {
    let file_name = p
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "text.txt".to_string());
    let meta = fs::metadata(p)
        .map_err(|e| format!("Kunde inte läsa filen {file_name}: {e}"))?;
    if meta.len() > MAX_TEXT_FILE_BYTES {
        let mb = meta.len() as f64 / (1024.0 * 1024.0);
        return Err(format!(
            "Filen {file_name} är för stor ({mb:.1} MB). Högsta tillåtna storlek för textimport är 10 MB."
        ));
    }
    let raw = fs::read_to_string(p)
        .map_err(|e| format!("Kunde inte läsa filen {file_name}: {e}"))?;

    // Om användaren öppnar en Transkerat-sparad transkribering.json, plocka ut texten snyggt.
    let content = if p
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("json"))
    {
        serde_json::from_str::<serde_json::Value>(&raw)
            .ok()
            .and_then(|v| {
                v.get("rawText")
                    .and_then(|t| t.as_str())
                    .map(|s| s.to_string())
                    .or_else(|| {
                        v.get("segments").and_then(|arr| arr.as_array()).map(|segs| {
                            segs.iter()
                                .filter_map(|s| s.get("text").and_then(|t| t.as_str()))
                                .collect::<Vec<_>>()
                                .join("\n")
                        })
                    })
            })
            .unwrap_or(raw)
    } else {
        raw
    };

    Ok(PickedTextFile { file_name, content })
}

/// Öppnar en befintlig textfil eller sparad transkribering (.txt, .md, .csv, .json) för direkt maskering.
#[tauri::command]
async fn pick_text_file(app_handle: AppHandle) -> Result<Option<PickedTextFile>, String> {
    use tauri_plugin_dialog::FilePath;
    let path = app_handle
        .dialog()
        .file()
        .set_title("Öppna textfil eller transkribering")
        .add_filter("Text & transkribering", &["txt", "md", "csv", "json"])
        .blocking_pick_file();
    let Some(FilePath::Path(p)) = path else {
        return Ok(None);
    };
    Ok(Some(read_picked_text_path(&p)?))
}

/// Läser en textfil som släppts via Drag & Drop (begränsad till text-/transkriberingsändelser).
#[tauri::command]
async fn read_text_file(path: String) -> Result<PickedTextFile, String> {
    let p = PathBuf::from(&path);
    let ok_ext = p
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| matches!(e.to_ascii_lowercase().as_str(), "txt" | "md" | "csv" | "json"));
    if !ok_ext || !p.is_file() {
        return Err("Filtypen stöds inte för textimport (använd .txt, .md, .csv eller .json).".into());
    }
    read_picked_text_path(&p)
}

#[tauri::command]
async fn pick_audio_file(app_handle: AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::FilePath;
    let path = app_handle
        .dialog()
        .file()
        .add_filter("Ljud/Video", ALLOWED_MEDIA_EXTS)
        .blocking_pick_file();
    match path {
        Some(FilePath::Path(p)) => Ok(Some(p.to_string_lossy().to_string())),
        _ => Ok(None),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState {
            cancel_flag: Arc::new(AtomicBool::new(false)),
            audio_recorder: Mutex::new(AudioRecorder::new()),
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            logging::init_logging(&app.handle());
            logging::install_crash_logging();
            log_line(&format!("=== Transkerat start v{} ===", env!("CARGO_PKG_VERSION")));
            log_line(&format!("num_cpus::get() = {}", num_cpus::get()));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            models::check_pianissimo_ready,
            models::download_pianissimo_model,
            models::check_diarization_models,
            models::download_diarization_models,
            models::get_installed_models,
            models::delete_model,
            check_ner_model_status,
            ensure_ner_model,
            analyze_text,
            vocabulary::vocab_load,
            vocabulary::vocab_save,
            vocabulary::vocab_dir,
            vocabulary::vocab_add_entry,
            vocabulary::apply_vocabulary,
            vocabulary::open_vocab_dir,
            session::get_disk_info,
            session::get_default_recording_dir,
            session::is_network_folder,
            session::legacy_network_recording_dir,
            session::recover_session,
            session::count_recordings,
            session::list_recordings,
            session::delete_all_recordings,
            session::delete_recording,
            session::reset_application,
            session::save_audio_file,
            session::open_session_folder,
            session::get_recording_path,
            session::rename_session,
            session::ensure_work_session,
            session::save_session_transcript,
            session::save_session_masking,
            session::clear_session_masking,
            session::load_session_workspace,
            start_backend_recording,
            stop_backend_recording,
            transcribe_file,
            cancel_transcription,
            get_app_version,
            save_text_file,
            pick_audio_file,
            pick_text_file,
            read_text_file,
            logging::get_log_path,
            logging::log_message,
            logging::open_log_file,
            logging::reveal_log_file,
            logging::read_log,
            append_mic_chunk,
            allow_asset_path,
            crashguard::take_crash_marker,
            crashguard::get_gpu_info
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                crashguard::clear_on_exit(app);
            }
        });
}
