/** The safety gate's levels (see CLAUDE.md "Harv's safety model"). */
export type Tier = 'green' | 'yellow' | 'red' | 'blocked';

export type ActionStatus = 'pending' | 'running' | 'done' | 'failed' | 'denied' | 'blocked' | 'undone';

/** One tool call in the action log. Its id is the Claude tool_use id. */
export interface ActionEntry {
  id: string;
  tabId: string;
  at: number;
  tool: string;
  tier: Tier;
  /** What it does, in plain words. */
  summary: string;
  /** Why it got its tier. */
  reason: string;
  status: ActionStatus;
  /** Paths backed up before it ran. */
  backups: string[];
  canUndo: boolean;
  /** Short outcome: an error, or what verification found. */
  result?: string;
}

/** One backup as Settings › Safety › Backups lists it (`GET /api/backups`). */
export interface BackupInfo {
  /** The folder name inside ~/.harv/backups (what `POST /api/backups/keep` takes). */
  name: string;
  at: number;
  bytes: number;
  /** What was backed up. */
  originals: string[];
  /** Kept forever: the cleanup never deletes it. */
  kept: boolean;
  /** The action it was made for: what Harv was doing, and whether Restore (its Undo) still works. */
  action?: { id: string; summary: string; canUndo: boolean };
}

/** One of Claude's multiple-choice questions (Claude Code's AskUserQuestion). */
export interface QuestionItem {
  question: string;
  /** A short chip label. */
  header: string;
  options: { label: string; description: string; preview?: string }[];
  multiSelect: boolean;
}

/**
 * Something waiting for the user's decision: a red action (`action`, the default), Claude's
 * questions (`question`: the answers go back to Claude) or a plan to approve (`plan`).
 */
export interface ApprovalRequest {
  kind?: 'action' | 'question' | 'plan';
  id: string;
  tabId: string;
  at: number;
  tool: string;
  summary: string;
  reason: string;
  /** The exact command. */
  command?: string;
  /** Exactly what will be affected. */
  preview: string;
  /** Paths that were backed up first. */
  backups: string[];
  /** Set when no automatic backup was possible. */
  backupNote?: string;
  /** `question`: what Claude asks. */
  questions?: QuestionItem[];
  /** `plan`: the plan, as Markdown. */
  plan?: string;
}

export type SafetyClientMessage =
  /**
   * `answers`: a question card's answers by question text (several picks joined with ", ").
   * `why`: what the user said instead (a denied plan's feedback, or a reason).
   */
  | {
      type: 'approval.answer';
      id: string;
      approve: boolean;
      answers?: Record<string, string>;
      why?: string;
    }
  | { type: 'action.undo'; id: string };

export type SafetyServerMessage =
  | { type: 'approval.request'; approval: ApprovalRequest }
  | { type: 'approval.resolved'; id: string; tabId: string; approved: boolean }
  | { type: 'action'; action: ActionEntry }
  /**
   * Desktop control (docs/PLAN.md §6t item 1): a chat is using the mouse and keyboard (`action`: what
   * it's doing now, `since`: when its reply took over, `at`: where on the screen, in Windows-MCP's
   * physical pixels), or stopped (`action: null`). The app shows
   * its pill, the dashboard marks the chat.
   */
  | { type: 'desktop.control'; tabId: string; action: string | null; since?: number; at?: [number, number] };
