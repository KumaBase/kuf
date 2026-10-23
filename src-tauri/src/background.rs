/// Keep blocking filesystem work off both the window thread and async workers.
pub async fn run<T, F>(work: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|error| format!("Background task failed: {error}"))?
}

#[cfg(test)]
mod tests {
    #[tokio::test(flavor = "current_thread")]
    async fn blocking_work_does_not_block_the_caller() {
        let caller = std::thread::current().id();
        let worker = super::run(move || {
            assert_ne!(caller, std::thread::current().id());
            Ok(42)
        })
        .await
        .unwrap();
        assert_eq!(worker, 42);
    }
}
