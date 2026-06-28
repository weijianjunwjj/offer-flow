use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileDocument {
    pub resume_text: String,
    pub project_experience: String,
    pub target_city: String,
    pub target_role: String,
    pub expected_salary: String,
    pub accept_outsourcing: bool,
    pub accept_overtime: bool,
    pub job_search_focus: String,
    pub weakness_note: String,
    pub updated_at: i64,
}

impl ProfileDocument {
    pub fn smoke(updated_at: i64) -> Self {
        Self {
            resume_text: "T3 smoke resume".to_string(),
            project_experience: "T3 smoke project".to_string(),
            target_city: "Suzhou".to_string(),
            target_role: "Frontend Developer".to_string(),
            expected_salary: "20-25K".to_string(),
            accept_outsourcing: false,
            accept_overtime: true,
            job_search_focus: "growth".to_string(),
            weakness_note: "T3 smoke only".to_string(),
            updated_at,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobDocument {
    pub id: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub company: String,
    pub role: String,
    pub city: String,
    pub salary_range: String,
    pub communication_status: String,
    pub parse_status: String,
    pub ai_pasted_at: Option<i64>,
    pub match_score: String,
    pub opportunity_score: Option<i64>,
    pub apply_advice: Option<String>,
    pub risk_level: Option<String>,
    pub company_size_tier: Option<String>,
    pub last_greeted_at: Option<i64>,
    pub followup_count: i64,
    pub last_followup_at: Option<i64>,
    pub high_value_signal: bool,
}

impl JobDocument {
    pub fn smoke(id: &str, updated_at: i64) -> Self {
        Self {
            id: id.to_string(),
            created_at: updated_at - 100,
            updated_at,
            company: "T3 Test Co".to_string(),
            role: "Frontend Engineer".to_string(),
            city: "Suzhou".to_string(),
            salary_range: "20-25K".to_string(),
            communication_status: "greeted_unread".to_string(),
            parse_status: "parsed".to_string(),
            ai_pasted_at: Some(updated_at - 50),
            match_score: "82".to_string(),
            opportunity_score: Some(76),
            apply_advice: Some("ok".to_string()),
            risk_level: Some("medium".to_string()),
            company_size_tier: Some("medium".to_string()),
            last_greeted_at: Some(updated_at - 40),
            followup_count: 1,
            last_followup_at: Some(updated_at - 10),
            high_value_signal: true,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredProfile {
    pub id: String,
    pub target_city: Option<String>,
    pub target_role: Option<String>,
    pub expected_salary: Option<String>,
    pub updated_at: i64,
    pub data_json: Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredJob {
    pub id: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub company: String,
    pub role: String,
    pub city: Option<String>,
    pub salary_range: Option<String>,
    pub communication_status: Option<String>,
    pub parse_status: Option<String>,
    pub ai_pasted_at: Option<i64>,
    pub match_score: Option<String>,
    pub opportunity_score: Option<i64>,
    pub apply_advice: Option<String>,
    pub risk_level: Option<String>,
    pub company_size_tier: Option<String>,
    pub last_greeted_at: Option<i64>,
    pub followup_count: i64,
    pub last_followup_at: Option<i64>,
    pub high_value_signal: i64,
    pub data_json: Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct T3RepositorySmokeResult {
    pub db_path: String,
    pub schema_version: String,
    pub profile_id: String,
    pub profile_target_city: String,
    pub job_id: String,
    pub listed_job_ids: Vec<String>,
    pub deleted_old_job: bool,
    pub deleted_new_job: bool,
    pub deleted_job_missing: bool,
    pub remaining_job_count: usize,
}
