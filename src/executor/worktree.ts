/**
 * Worktree manager — gives each task its own sandbox directory.
 *
 * v3 keeps it dumb: a plain temp dir, no git clone (Claude can `git clone`
 * itself when it actually needs a repo). The point is just isolation:
 * one task's `pwd` cannot stomp on another's.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { loadEnv } from "../config/env.js";

const env = loadEnv();

export interface Worktree {
  taskId: string;
  cwd: string;
  destroy: () => void;
}

export function createWorktree(taskId: string): Worktree {
  fs.mkdirSync(env.WORKTREE_BASE, { recursive: true });
  const cwd = path.join(env.WORKTREE_BASE, `task-${taskId}-${Date.now()}`);
  fs.mkdirSync(cwd, { recursive: true });
  return {
    taskId,
    cwd,
    destroy: () => {
      try {
        fs.rmSync(cwd, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  };
}
