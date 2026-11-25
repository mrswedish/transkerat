//! Modellkatalog, sökvägar och nedladdning (Pianissimo, Talaridentifiering, Svensk BERT NER).
//! 100 % svenska, 100 % lokalt — inga Whisper-modeller.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use futures_util::StreamExt;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::types::*;
use crate::{diarization, pianissimo};

/// Filer för KBLab Svensk BERT NER (INT8 ONNX, ~127 MB)
pub(crate) const NER_MODEL_DIR: &str = "bert-swedish-ner";
pub(crate) const HF_BASE_NER: &str =
    "https://huggingface.co/psvensk/bert-base-swedish-cased-ner-onnx/resolve/main";

pub(crate) const NER_FILES: &[(&str, &str, u64)] = &[
    ("onnx/model_quantized.onnx", "model_quantized.onnx", 125_800_000),
    ("tokenizer.json", "tokenizer.json", 1_150_000),
    ("tokenizer_config.json", "tokenizer_config.json", 1_300),
    ("special_tokens_map.json", "special_tokens_map.json", 125),
    ("config.json", "config.json", 1_200),
];

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NerDownloadProgress {
    pub(crate) phase: String,
    pub(crate) label: String,
    pub(crate) downloaded: u64,
    pub(crate) total: u64,
    pub(crate) progress: f32,
}

pub(crate) fn models_root(app_handle: &AppHandle) -> Result<PathBuf, String> {
    let dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("models");
    if !dir.exists() {
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    Ok(dir)
}

pub(crate) fn pianissimo_dir(app_handle: &AppHandle) -> Result<PathBuf, String> {
    Ok(pianissimo::model_dir(&models_root(app_handle)?))
}

pub(crate) fn diarization_dir(app_handle: &AppHandle) -> Result<PathBuf, String> {
    Ok(diarization::model_dir(&models_root(app_handle)?))
}

pub(crate) fn ner_dir(app_handle: &AppHandle) -> Result<PathBuf, String> {
    let dir = models_root(app_handle)?.join(NER_MODEL_DIR);
    if !dir.exists() {
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    Ok(dir)
}

pub(crate) fn ner_is_ready(dir: &Path) -> bool {
    NER_FILES
        .iter()
        .all(|&(_, local_name, _)| dir.join(local_name).is_file())
}

/// Flerfilsnedladdning med fast revision, SHA-256-kontroll och samlad progress.
async fn download_files(
    app_handle: &AppHandle,
    dir: PathBuf,
    files: &[(&str, &str, u64)],
    url_of: fn(&str) -> String,
) -> Result<String, String> {
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let total_expected: u64 = files.iter().map(|f| f.2).sum();
    let mut done_before: u64 = 0;
    let mut last_emit_mb = 0u64;

    for (name, sha, approx) in files {
        let target = dir.join(name);
        if target.exists() && pianissimo::file_hash(&target).map(|h| h == *sha).unwrap_or(false) {
            done_before += approx;
            continue;
        }
        let tmp = dir.join(format!("{name}.tmp"));
        let res = reqwest::get(url_of(name)).await.map_err(|e| format!(
            "Ingen kontakt med servern där modellen finns (huggingface.co).\n\n\
             Kontrollera nätverket. På en arbetsdator kan brandvägg eller proxy blockera \
             nedladdningen — kontakta i så fall IT-support.\n\nTeknisk information: {e}"
        ))?;
        if !res.status().is_success() {
            return Err(format!(
                "Servern nekade nedladdningen (HTTP {}).\n\n\
                 Försök igen om en stund. Kvarstår problemet kan brandvägg eller proxy \
                 blockera åtkomsten till huggingface.co.",
                res.status()
            ));
        }
        let mut file = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
        let mut stream = res.bytes_stream();
        let mut got: u64 = 0;
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| e.to_string())?;
            file.write_all(&chunk).map_err(|e| e.to_string())?;
            got += chunk.len() as u64;
            let total_done = done_before + got;
            let mb = total_done / 1_048_576;
            if mb > last_emit_mb {
                last_emit_mb = mb;
                let progress = (total_done as f32 / total_expected as f32 * 99.0).min(99.0);
                let _ = app_handle.emit(
                    "download_progress",
                    ProgressPayload {
                        progress,
                        downloaded: total_done,
                        total: total_expected,
                    },
                );
            }
        }
        drop(file);
        let hash = pianissimo::file_hash(&tmp).map_err(|e| e.to_string())?;
        if hash != *sha {
            let _ = fs::remove_file(&tmp);
            return Err(format!(
                "Den nedladdade filen {name} är skadad (kontrollsumman stämmer inte). Försök ladda ned igen."
            ));
        }
        fs::rename(&tmp, &target).map_err(|e| e.to_string())?;
        done_before += approx;
    }
    let _ = app_handle.emit(
        "download_progress",
        ProgressPayload {
            progress: 100.0,
            downloaded: total_expected,
            total: total_expected,
        },
    );
    Ok(dir.to_string_lossy().to_string())
}

/// Ladda ned Svensk BERT NER-filer till `ner_dir` med progress-events.
pub(crate) async fn download_ner_files(app_handle: &AppHandle) -> Result<PathBuf, String> {
    let dir = ner_dir(app_handle)?;
    let total_expected: u64 = NER_FILES.iter().map(|f| f.2).sum();
    let mut done_before: u64 = 0;
    let mut last_emit_mb = 0u64;

    for &(remote_rel, local_name, approx) in NER_FILES {
        let target = dir.join(local_name);
        if target.is_file() {
            done_before += approx;
            continue;
        }
        let tmp = dir.join(format!("{local_name}.tmp"));
        let url = format!("{HF_BASE_NER}/{remote_rel}");
        let res = reqwest::get(&url).await.map_err(|e| format!(
            "Ingen kontakt med servern där maskeringsmodellen finns (huggingface.co).\n\n\
             Kontrollera nätverket eller eventuell brandvägg/proxy.\n\nTeknisk information: {e}"
        ))?;
        if !res.status().is_success() {
            return Err(format!(
                "Servern nekade nedladdningen av maskeringsmodellen (HTTP {}).",
                res.status()
            ));
        }
        let mut file = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
        let mut stream = res.bytes_stream();
        let mut got: u64 = 0;
        let write_res: Result<(), String> = async {
            while let Some(chunk) = stream.next().await {
                let chunk = chunk.map_err(|e| e.to_string())?;
                file.write_all(&chunk).map_err(|e| e.to_string())?;
                got += chunk.len() as u64;
                let total_done = done_before + got;
                let mb = total_done / 1_048_576;
                if mb > last_emit_mb {
                    last_emit_mb = mb;
                    let progress = (total_done as f32 / total_expected as f32 * 99.0).min(99.0);
                    let _ = app_handle.emit(
                        "ner_download_progress",
                        NerDownloadProgress {
                            phase: "downloading".into(),
                            label: format!("Hämtar maskeringsmodell ({local_name})…"),
                            downloaded: total_done,
                            total: total_expected,
                            progress,
                        },
                    );
                }
            }
            Ok(())
        }
        .await;
        drop(file);
        if let Err(e) = write_res {
            let _ = fs::remove_file(&tmp);
            return Err(e);
        }
        fs::rename(&tmp, &target).map_err(|e| {
            let _ = fs::remove_file(&tmp);
            e.to_string()
        })?;
        done_before += approx;
    }

    let _ = app_handle.emit(
        "ner_download_progress",
        NerDownloadProgress {
            phase: "loading".into(),
            label: "Startar svensk maskeringsmodell…".into(),
            downloaded: total_expected,
            total: total_expected,
            progress: 100.0,
        },
    );

    Ok(dir)
}

#[tauri::command]
pub(crate) fn check_pianissimo_ready(app_handle: AppHandle) -> Result<bool, String> {
    Ok(pianissimo::is_ready(&pianissimo_dir(&app_handle)?))
}

#[tauri::command]
pub(crate) async fn download_pianissimo_model(app_handle: AppHandle) -> Result<String, String> {
    let dir = pianissimo_dir(&app_handle)?;
    download_files(&app_handle, dir, pianissimo::FILES, pianissimo::download_url).await
}

#[tauri::command]
pub(crate) fn check_diarization_models(app_handle: AppHandle) -> Result<bool, String> {
    Ok(diarization::is_ready(&diarization_dir(&app_handle)?))
}

#[tauri::command]
pub(crate) async fn download_diarization_models(app_handle: AppHandle) -> Result<String, String> {
    let dir = diarization_dir(&app_handle)?;
    download_files(&app_handle, dir, diarization::FILES, diarization::download_url).await
}

#[tauri::command]
pub(crate) async fn get_installed_models(app_handle: AppHandle) -> Result<Vec<ModelInfo>, String> {
    let mut models = Vec::new();

    let pian_dir = pianissimo_dir(&app_handle)?;
    let pian_ready = pianissimo::is_ready(&pian_dir);
    let pian_bytes: u64 = if pian_ready {
        pianissimo::FILES
            .iter()
            .filter_map(|(n, _, _)| fs::metadata(pian_dir.join(n)).ok())
            .map(|m| m.len())
            .sum()
    } else {
        0
    };
    models.push(ModelInfo {
        name: "Pianissimo · Svensk taligenkänning".to_string(),
        size: pianissimo::ENGINE_ID.to_string(),
        revision: "standard".to_string(),
        quantized: true,
        size_bytes: pian_bytes,
        downloaded: pian_ready,
    });

    let ndir = ner_dir(&app_handle)?;
    let n_ready = ner_is_ready(&ndir);
    let ner_bytes: u64 = if n_ready {
        NER_FILES
            .iter()
            .filter_map(|(_, n, _)| fs::metadata(ndir.join(n)).ok())
            .map(|m| m.len())
            .sum()
    } else {
        0
    };
    models.push(ModelInfo {
        name: "KBLab Svensk BERT NER · Maskering".to_string(),
        size: "ner".to_string(),
        revision: "int8".to_string(),
        quantized: true,
        size_bytes: ner_bytes,
        downloaded: n_ready,
    });

    let ddir = diarization_dir(&app_handle)?;
    let d_ready = diarization::is_ready(&ddir);
    let d_bytes: u64 = if d_ready {
        diarization::FILES
            .iter()
            .filter_map(|(n, _, _)| fs::metadata(ddir.join(n)).ok())
            .map(|m| m.len())
            .sum()
    } else {
        0
    };
    models.push(ModelInfo {
        name: "Talaridentifiering (pyannote)".to_string(),
        size: "diarization".to_string(),
        revision: "community-1".to_string(),
        quantized: false,
        size_bytes: d_bytes,
        downloaded: d_ready,
    });

    Ok(models)
}

#[tauri::command]
pub(crate) async fn delete_model(app_handle: AppHandle, size: String) -> Result<(), String> {
    let dir = match size.as_str() {
        "pianissimo" => pianissimo_dir(&app_handle)?,
        "ner" => ner_dir(&app_handle)?,
        "diarization" => diarization_dir(&app_handle)?,
        _ => return Err(format!("Okänd modell: {size}")),
    };
    if dir.exists() {
        fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    Ok(())
}
