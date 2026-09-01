/** Kanban schema types — minimum shape the UI consumes. */

export type IssueStatus = "backlog" | "todo" | "in_progress" | "review" | "done";
export type IssuePriority = "critical" | "high" | "medium" | "low";

export interface User {
  id: number;
  name: string;
  email: string;
  role: string;
  avatar_url: string | null;
}

export interface Comment {
  id: number;
  body: string;
  author_id: number;
  created_at: string;
}

export interface Label {
  id: number;
  name: string;
  color: string;
}

export interface Issue {
  id: number;
  project_id: number;
  sprint_id: number | null;
  title: string;
  description: string | null;
  priority: IssuePriority | string;
  status: IssueStatus | string;
  story_points: number | null;
  reporter_id: number;
  assignee_id: number | null;
  created_at: string;
  updated_at: string;
  kanbanComments: Comment[];
  kanbanIssueLabels: Array<{ kanbanLabels: Label }>;
}

export interface Project {
  id: number;
  name: string;
  key: string;
  description: string | null;
  is_public: boolean;
  org_id: number;
  archived: boolean;
}

export const STATUS_ORDER: IssueStatus[] = [
  "backlog",
  "todo",
  "in_progress",
  "review",
  "done",
];

export const STATUS_LABELS: Record<IssueStatus, string> = {
  backlog: "Backlog",
  todo: "To Do",
  in_progress: "In Progress",
  review: "In Review",
  done: "Done",
};

export const PRIORITY_LABEL: Record<IssuePriority, string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
};
