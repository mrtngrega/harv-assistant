import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { promisify } from 'node:util';
import type { ProjectServerMessage } from '@harv/shared';
import { osPath, pathKey } from '../platform.ts';
import { projectsDir } from '../settings.ts';
import type { ChatStore } from '../store/chats.ts';
import { createGitHubRepo, pullNotice, pullProject, remoteOf } from './projectRepo.ts';
import type { ProjectTools } from './chatTools.ts';

// The user's projects for ChatManager (docs/PLAN.md §6f): the project list, Harv's start_project /
// open_project / remove_project tools, and a project pulled up to date when it's opened.
// Moving a chat into or out of a project stays in the manager (it ends the chat's session).

/** What the project code needs from the chat manager. */
export interface ProjectLinkDeps {
  store: ChatStore;
  broadcast: (msg: ProjectServerMessage) => void;
  publishHistory: () => void;
  /** A chat is replying (its project isn't pulled under it). */
  busy: (tabId: string) => boolean;
  /** Moves a chat into a project (or out with null); returns an error. */
  setProject: (tabId: string, projectId: string | null) => string | undefined;
  /** One dated line in harv_report.md or harv_skills.md (report_note). */
  writeReport: (tabId: string, text: string, skills?: boolean) => string;
}

/** The first CLAUDE.md of a project Harv starts; the project chat fills it in as decisions are made. */
function starterClaudeMd(name: string, description: string): string {
  return [
    `# ${name}`,
    '',
    description.trim() || 'A new project.',
    '',
    '## Status',
    '',
    `Started ${new Date().toISOString().slice(0, 10)}. Nothing built yet.`,
    '',
    '## Stack',
    '',
    'Not decided yet.',
    '',
    '## Commands',
    '',
    'None yet.',
    '',
  ].join('\n');
}

export class ProjectLink {
  constructor(private deps: ProjectLinkDeps) {}

  publishProjects() {
    this.deps.broadcast({ type: 'projects', projects: this.deps.store.projects() });
  }

  /** Adds an existing folder as a project. */
  addProject(path: string, name?: string): string | undefined {
    const folder = osPath.normalize(path.trim());
    if (!osPath.isAbsolute(folder) || !existsSync(folder) || !statSync(folder).isDirectory()) return `No folder at ${path}.`;
    const project = this.deps.store.addProject(name?.trim() || osPath.basename(folder), folder);
    this.publishProjects();
    void this.noteRemote(project.id, folder);
    return undefined;
  }

  removeProject(id: string): void {
    for (const chat of this.deps.store.openChats()) if (chat.projectId === id) this.deps.setProject(chat.id, null);
    this.deps.store.removeProject(id);
    this.publishProjects();
    this.deps.publishHistory();
  }

  /** Makes a new project's GitHub repo and returns its remote; replaced in tests. */
  createRepo = createGitHubRepo;
  private projectNotice(message: string) {
    this.deps.broadcast({ type: 'project.notice', message });
  }

  /** A project's folder has a GitHub repo: remember it, and the other devices hear about it. */
  private async noteRemote(id: string, path: string) {
    const remote = await remoteOf(path);
    if (remote) this.deps.store.setProjectRemote(id, remote);
    this.publishProjects();
  }

  /** Opening a project: bring it up to date first, or say why not. */
  async pullOnOpen(projectId: string) {
    const p = this.deps.store.project(projectId);
    if (!p?.remote || !existsSync(p.path)) return;
    const result = await pullProject(p.path);
    const notice = pullNotice(p.name, result);
    if (notice) this.projectNotice(notice);
  }

  /** Harv's start_project / open_project / list_projects tools. */
  readonly tools: ProjectTools = {
    list: () => this.deps.store.projects(),
    report: (tabId, note, skills) => this.deps.writeReport(tabId, note, skills),
    start: async (tabId, rawName, description, visibility) => {
      // Characters Windows doesn't allow in folder names (and control characters) go.
      const name = [...rawName.trim()]
        .filter((c) => c.charCodeAt(0) >= 32 && !'<>:"/\\|?*'.includes(c))
        .join('')
        .replace(/\s+/g, ' ')
        .replace(/[. ]+$/, '');
      if (!name) return 'That name has no usable characters for a folder; pick another.';
      const path = osPath.join(projectsDir(), name);
      if (existsSync(path)) {
        return `${path} already exists. Ask the user whether to use it (open_project with that path) or pick another name.`;
      }
      mkdirSync(path, { recursive: true });
      writeFileSync(osPath.join(path, 'CLAUDE.md'), starterClaudeMd(name, description));
      let git = 'a git repository';
      try {
        await promisify(execFile)('git', ['init', '-b', 'main'], { cwd: path, windowsHide: true });
      } catch {
        git = 'no git repository (git init failed; try it in the project chat)';
      }
      const project = this.deps.store.addProject(name, path);
      let repo = '';
      if (git === 'a git repository') {
        try {
          const remote = await this.createRepo(path, name, visibility);
          this.deps.store.setProjectRemote(project.id, remote);
          repo = ` Its ${visibility} GitHub repo is ${remote}, with the first commit pushed.`;
        } catch (err) {
          const why = (err as Error).message.split('\n')[0];
          repo = ` Making its GitHub repo failed (${why}), so it stays on this device for now: tell the user, and once that's fixed (e.g. \`gh auth login\`), run \`gh repo create ${name} --${visibility} --source . --push\` in the project.`;
        }
      }
      this.publishProjects();
      this.deps.setProject(tabId, project.id);
      return `Created ${path} with ${git} and a starter CLAUDE.md, and this is now a project chat for "${name}".${repo} From the user's next message you work in that folder as Claude Code. Tell the user the folder you made and suggest the first step (the stack and a short plan).`;
    },
    open: async (tabId, nameOrPath) => {
      const wanted = nameOrPath.trim();
      let project = this.deps.store.projects().find((p) => p.name.toLowerCase() === wanted.toLowerCase());
      if (!project && osPath.isAbsolute(wanted)) {
        const error = this.addProject(wanted);
        if (error) return error;
        project = this.deps.store.projects().find((p) => pathKey(p.path) === pathKey(osPath.normalize(wanted)));
      }
      if (!project) {
        const known =
          this.deps.store
            .projects()
            .map((p) => p.name)
            .join(', ') || 'none yet';
        return `No project called "${wanted}" (known: ${known}). Ask the user for the folder path to add it.`;
      }
      this.deps.setProject(tabId, project.id);
      return `This is now a project chat for "${project.name}" (${project.path}). From the user's next message you work there as Claude Code, with its CLAUDE.md and memory.`;
    },
    remove: (name) => {
      const list = this.deps.store.projects();
      const project = list.find((p) => p.name.toLowerCase() === name.trim().toLowerCase());
      if (!project) return `No project called "${name}" (known: ${list.map((p) => p.name).join(', ') || 'none'}). Nothing removed.`;
      this.removeProject(project.id);
      return `"${project.name}" is off the project list; its chats are normal chats now. Its folder (${project.path}) and repo are untouched.`;
    },
  };
}
