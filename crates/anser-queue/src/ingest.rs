use std::sync::Arc;
use std::time::Duration;

use anser_core::api::Receipt;
use anser_store::queue::Submission;
use anser_store::{DataError, Result, Store};
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;
use tokio::time::{Instant, timeout_at};

const BATCH_LIMIT: usize = 32;
const BATCH_DELAY: Duration = Duration::from_millis(2);

type Job = (Submission, oneshot::Sender<Result<Receipt>>);

pub struct Enqueuer(mpsc::Sender<Job>);

impl Enqueuer {
    pub fn start(store: Arc<Store>) -> (Self, JoinHandle<()>) {
        let (sender, receiver) = mpsc::channel(BATCH_LIMIT * 2);
        (Self(sender), tokio::spawn(run(store, receiver)))
    }

    pub async fn enqueue(&self, input: Submission) -> Result<Receipt> {
        let (sender, result) = oneshot::channel();
        self.0.try_send((input, sender)).map_err(|error| {
            if matches!(error, mpsc::error::TrySendError::Full(_)) {
                DataError::QueueFull
            } else {
                DataError::Batch
            }
        })?;
        result.await.map_err(|_| DataError::Batch)?
    }
}

async fn run(store: Arc<Store>, mut pending: mpsc::Receiver<Job>) {
    while let Some(first) = pending.recv().await {
        let cutoff = Instant::now() + BATCH_DELAY;
        let mut jobs = Vec::with_capacity(BATCH_LIMIT);
        jobs.push(first);
        while jobs.len() < BATCH_LIMIT {
            match timeout_at(cutoff, pending.recv()).await {
                Ok(Some(job)) => jobs.push(job),
                _ => break,
            }
        }
        let (inputs, responses): (Vec<_>, Vec<_>) = jobs.into_iter().unzip();
        match store.enqueue_batch(inputs).await {
            Ok(receipts) => {
                for (response, receipt) in responses.into_iter().zip(receipts) {
                    let _ = response.send(receipt);
                }
            }
            Err(error) => {
                tracing::error!(%error, "ingress commit failed");
                for response in responses {
                    let _ = response.send(Err(DataError::Batch));
                }
            }
        }
    }
}
