use std::collections::HashMap;
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

/// How long a pending request waits for the app before Claude Code falls back
/// to its own in-terminal prompt. Keep below the hook timeout.
pub const DECISION_TIMEOUT: Duration = Duration::from_secs(90);

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Decision {
    Allow,
    Deny,
    Ask,
}

impl Decision {
    pub fn label(&self) -> &'static str {
        match self {
            Decision::Allow => "allow",
            Decision::Deny => "deny",
            Decision::Ask => "ask",
        }
    }

    /// The JSON Claude Code expects on the hook's stdout.
    pub fn to_hook_output(&self, reason: &str) -> serde_json::Value {
        let decision = match self {
            Decision::Allow => "allow",
            Decision::Deny => "deny",
            Decision::Ask => "ask",
        };
        serde_json::json!({
            "hookSpecificOutput": {
                "hookEventName": "PermissionRequest",
                "permissionDecision": decision,
                "permissionDecisionReason": reason,
            }
        })
    }
}

#[derive(Default)]
struct Inner {
    /// Request id -> decision, present once the app answers.
    answers: HashMap<String, (Decision, String)>,
    /// Ids still waiting, so a late answer for a dropped request is discarded.
    waiting: HashMap<String, ()>,
    /// The tool input the app filled in, such as the answers to a question.
    inputs: HashMap<String, serde_json::Value>,
}

#[derive(Clone, Default)]
pub struct Permissions {
    inner: Arc<(Mutex<Inner>, Condvar)>,
}

impl Permissions {
    pub fn register(&self, id: &str) {
        let (lock, _) = &*self.inner;
        lock.lock().unwrap().waiting.insert(id.to_string(), ());
    }

    /// Blocks until the app decides or `timeout` elapses.
    pub fn wait_for(&self, id: &str, timeout: Duration) -> Option<(Decision, String)> {
        let (lock, cv) = &*self.inner;
        let mut guard = lock.lock().unwrap();
        let deadline = std::time::Instant::now() + timeout;
        loop {
            if let Some(answer) = guard.answers.remove(id) {
                guard.waiting.remove(id);
                return Some(answer);
            }
            let remaining = deadline.saturating_duration_since(std::time::Instant::now());
            if remaining.is_zero() {
                guard.waiting.remove(id);
                return None;
            }
            let (next, timeout) = cv.wait_timeout(guard, remaining).unwrap();
            guard = next;
            if timeout.timed_out() && !guard.answers.contains_key(id) {
                guard.waiting.remove(id);
                return None;
            }
        }
    }

    /// Records the app's answer. Returns false when nothing was waiting for it.
    pub fn decide(&self, id: &str, decision: Decision, reason: String) -> bool {
        self.decide_with(id, decision, reason, None)
    }

    /// `decide`, along with a tool input that replaces the one the agent sent.
    pub fn decide_with(
        &self,
        id: &str,
        decision: Decision,
        reason: String,
        input: Option<serde_json::Value>,
    ) -> bool {
        let (lock, cv) = &*self.inner;
        let mut guard = lock.lock().unwrap();
        if !guard.waiting.contains_key(id) {
            return false;
        }
        if let Some(input) = input {
            guard.inputs.insert(id.to_string(), input);
        }
        guard.answers.insert(id.to_string(), (decision, reason));
        cv.notify_all();
        true
    }

    /// The tool input recorded with a decision, taken once.
    pub fn take_input(&self, id: &str) -> Option<serde_json::Value> {
        let (lock, _) = &*self.inner;
        lock.lock().unwrap().inputs.remove(id)
    }
}

#[tauri::command]
pub fn permission_decide(
    state: tauri::State<Permissions>,
    id: String,
    decision: Decision,
    reason: Option<String>,
    updated_input: Option<serde_json::Value>,
) -> bool {
    state.decide_with(
        &id,
        decision,
        reason.unwrap_or_else(|| "Decidido no Shellhive".into()),
        updated_input,
    )
}
