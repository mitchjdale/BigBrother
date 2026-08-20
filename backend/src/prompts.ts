import { db } from "./db.js";
import {
  DEFAULT_PROMPT_NAMES,
  DEFAULT_PROMPT_TEMPLATES,
  REQUIRED_PROMPT_PLACEHOLDERS,
} from "./prompt-templates.js";
import type { PromptRow, PromptType, PromptVersionRow } from "./types.js";

export interface Prompt {
  id: number;
  type: PromptType;
  name: string;
  template: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PromptVersion {
  id: number;
  promptId: number;
  type: PromptType;
  versionNo: number;
  template: string;
  changedBy: string | null;
  changeReason: string | null;
  createdAt: string;
}

export interface PromptValidationResult {
  valid: boolean;
  missingPlaceholders: string[];
}

function toPrompt(row: PromptRow): Prompt {
  return {
    id: row.id,
    type: row.type,
    name: row.name,
    template: row.template,
    isActive: Boolean(row.is_active),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toPromptVersion(row: PromptVersionRow & { type: PromptType }): PromptVersion {
  return {
    id: row.id,
    promptId: row.prompt_id,
    type: row.type,
    versionNo: row.version_no,
    template: row.template,
    changedBy: row.changed_by,
    changeReason: row.change_reason,
    createdAt: row.created_at,
  };
}

function placeholderSet(template: string): Set<string> {
  const out = new Set<string>();
  const re = /{{\s*([a-zA-Z0-9_]+)\s*}}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(template)) !== null) out.add(m[1]);
  return out;
}

export function validatePromptTemplate(type: PromptType, template: string): PromptValidationResult {
  const names = placeholderSet(template);
  const missingPlaceholders = REQUIRED_PROMPT_PLACEHOLDERS[type].filter((p) => !names.has(p));
  return { valid: missingPlaceholders.length === 0, missingPlaceholders };
}

export function renderPromptTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/{{\s*([a-zA-Z0-9_]+)\s*}}/g, (_m, key: string) => values[key] ?? "");
}

export function getActivePrompt(type: PromptType): Prompt | null {
  const row = db
    .prepare(`SELECT id, type, name, template, is_active, created_at, updated_at FROM prompts WHERE type=? AND is_active=1`)
    .get(type) as PromptRow | undefined;
  return row ? toPrompt(row) : null;
}

export function listPromptVersions(type?: PromptType): PromptVersion[] {
  const rows = type
    ? (db
        .prepare(
          `SELECT pv.id, pv.prompt_id, pv.version_no, pv.template, pv.changed_by, pv.change_reason, pv.created_at, p.type
           FROM prompt_versions pv
           JOIN prompts p ON p.id = pv.prompt_id
           WHERE p.type=?
           ORDER BY pv.version_no DESC`,
        )
        .all(type) as (PromptVersionRow & { type: PromptType })[])
    : (db
        .prepare(
          `SELECT pv.id, pv.prompt_id, pv.version_no, pv.template, pv.changed_by, pv.change_reason, pv.created_at, p.type
           FROM prompt_versions pv
           JOIN prompts p ON p.id = pv.prompt_id
           ORDER BY p.type ASC, pv.version_no DESC`,
        )
        .all() as (PromptVersionRow & { type: PromptType })[]);
  return rows.map(toPromptVersion);
}

export function updatePrompt(
  type: PromptType,
  newTemplate: string,
  changeReason?: string,
  changedBy?: string,
): Prompt {
  const validation = validatePromptTemplate(type, newTemplate);
  if (!validation.valid) {
    throw new Error(`missing placeholders: ${validation.missingPlaceholders.join(", ")}`);
  }

  const row = db
    .prepare(`SELECT id, type, name, template, is_active, created_at, updated_at FROM prompts WHERE type=? AND is_active=1`)
    .get(type) as PromptRow | undefined;
  if (!row) throw new Error(`active prompt not found for type ${type}`);

  const tx = db.transaction(() => {
    db.prepare(`UPDATE prompts SET template=?, updated_at=datetime('now') WHERE id=?`).run(newTemplate, row.id);
    const current = db
      .prepare(`SELECT COALESCE(MAX(version_no), 0) AS v FROM prompt_versions WHERE prompt_id=?`)
      .get(row.id) as { v: number };
    db.prepare(
      `INSERT INTO prompt_versions (prompt_id, version_no, template, changed_by, change_reason)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      row.id,
      current.v + 1,
      newTemplate,
      changedBy ?? null,
      changeReason?.trim() ? changeReason.trim() : null,
    );
  });

  tx();
  const updated = getActivePrompt(type);
  if (!updated) throw new Error(`active prompt not found for type ${type}`);
  return updated;
}

export function resetPromptToDefault(type: PromptType): Prompt {
  return updatePrompt(type, DEFAULT_PROMPT_TEMPLATES[type], "Reset to default template");
}

export function defaultPromptTemplate(type: PromptType): string {
  return DEFAULT_PROMPT_TEMPLATES[type];
}

export function defaultPromptName(type: PromptType): string {
  return DEFAULT_PROMPT_NAMES[type];
}
