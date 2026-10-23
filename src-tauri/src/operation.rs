use serde::Serialize;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use tauri::Emitter;

#[derive(Clone)]
pub struct Operation {
    id: String,
    cancelled: Arc<AtomicBool>,
}

#[derive(Default)]
pub struct Operations(Mutex<Option<Operation>>);

#[derive(Clone, Serialize)]
struct Progress<'a> {
    id: &'a str,
    completed: usize,
    total: usize,
}

impl Operations {
    pub fn get(&self, id: Option<&str>) -> Result<Option<Operation>, String> {
        let Some(id) = id else { return Ok(None) };
        self.0
            .lock()
            .map_err(|e| e.to_string())?
            .as_ref()
            .filter(|op| op.id == id)
            .cloned()
            .map(Some)
            .ok_or_else(|| "Operation is no longer active".to_string())
    }
}

impl Operation {
    // Stop between top-level items. A move finishes its current copy/delete pair
    // before cancellation is observed, so a cancellation never deletes its source.
    pub fn check(&self) -> Result<(), String> {
        if self.cancelled.load(Ordering::Relaxed) {
            Err("処理を停止しました。完了した項目の変更は保持されています。".to_string())
        } else {
            Ok(())
        }
    }
    pub fn progress(&self, app: &tauri::AppHandle, completed: usize, total: usize) {
        let _ = app.emit(
            "file-operation-progress",
            Progress {
                id: &self.id,
                completed,
                total,
            },
        );
    }
}

#[tauri::command]
pub fn operation_begin(id: String, state: tauri::State<Operations>) -> Result<(), String> {
    let mut current = state.0.lock().map_err(|e| e.to_string())?;
    if current.is_some() {
        return Err("Another operation is running".to_string());
    }
    *current = Some(Operation {
        id,
        cancelled: Arc::new(AtomicBool::new(false)),
    });
    Ok(())
}

#[tauri::command]
pub fn operation_cancel(id: String, state: tauri::State<Operations>) -> Result<(), String> {
    if let Some(op) = state.get(Some(&id))? {
        op.cancelled.store(true, Ordering::Relaxed);
    }
    Ok(())
}

#[tauri::command]
pub fn operation_end(id: String, state: tauri::State<Operations>) -> Result<(), String> {
    let mut current = state.0.lock().map_err(|e| e.to_string())?;
    if current.as_ref().is_some_and(|op| op.id == id) {
        *current = None;
    }
    Ok(())
}

pub fn process_items<T>(
    items: &[T],
    op: Option<&Operation>,
    app: &tauri::AppHandle,
    mut action: impl FnMut(&T, usize) -> Result<(), String>,
) -> Result<(), String> {
    process_items_inner(
        items,
        op,
        |completed, total| {
            if let Some(op) = op {
                op.progress(app, completed, total);
            }
        },
        &mut action,
    )
}

fn process_items_inner<T>(
    items: &[T],
    op: Option<&Operation>,
    mut progress: impl FnMut(usize, usize),
    mut action: impl FnMut(&T, usize) -> Result<(), String>,
) -> Result<(), String> {
    progress(0, items.len());
    let mut last = std::time::Instant::now();
    for (index, item) in items.iter().enumerate() {
        if let Some(op) = op {
            op.check()?;
        }
        action(item, index)?;
        if op.is_some() {
            if last.elapsed().as_millis() >= 100 || index + 1 == items.len() {
                progress(index + 1, items.len());
                last = std::time::Instant::now();
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cancellation_is_scoped_to_its_operation() {
        let op = Operation {
            id: "one".into(),
            cancelled: Arc::new(AtomicBool::new(false)),
        };
        let state = Operations(Mutex::new(Some(op.clone())));
        assert!(state.get(Some("other")).is_err());
        assert!(op.check().is_ok());
        op.cancelled.store(true, Ordering::Relaxed);
        assert!(state.get(Some("one")).unwrap().unwrap().check().is_err());
        assert!(state.get(None).unwrap().is_none());
    }

    #[test]
    fn cancellation_finishes_one_item_and_does_not_start_the_next() {
        let op = Operation {
            id: "copy".into(),
            cancelled: Arc::new(AtomicBool::new(false)),
        };
        let mut completed = Vec::new();
        let result = process_items_inner(
            &[1, 2, 3],
            Some(&op),
            |_, _| {},
            |item, _| {
                completed.push(*item);
                op.cancelled.store(true, Ordering::Relaxed);
                Ok(())
            },
        );
        assert!(result.is_err());
        assert_eq!(completed, vec![1]);
    }

    #[test]
    fn failures_stop_the_batch_and_propagate() {
        let mut completed = Vec::new();
        let result = process_items_inner(
            &[1, 2, 3],
            None,
            |_, _| {},
            |item, _| {
                if *item == 2 {
                    return Err("disk full".into());
                }
                completed.push(*item);
                Ok(())
            },
        );
        assert_eq!(result, Err("disk full".into()));
        assert_eq!(completed, vec![1]);
    }
}
