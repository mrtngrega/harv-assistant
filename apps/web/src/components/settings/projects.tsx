import { projectActions, updateSettings, useProjects, useSettings } from '../../lib/useHarvSocket.ts';
import { AddPath, Group, Note, PathList, Sub, TextSetting, useExample } from './controls.tsx';

export function Projects() {
  const example = useExample('C:\\path\\to\\a\\project', '/path/to/a/project');
  const defaultRoot = useExample('your home\\Projects', 'your home/Projects');
  const { list, error } = useProjects();
  const { projectsDir } = useSettings();
  return (
    <Sub title="Projects">
      <Note>
        In a project chat Harv works like Claude Code in that folder. Say “let’s work on …”, or pick one in the project menu at the top
        right of a chat.
      </Note>
      <PathList
        items={list.map((p) => ({ key: p.id, title: `▣ ${p.name}`, path: p.path, label: `Forget ${p.name} (the folder and chats stay)` }))}
        onRemove={(id) => projectActions.remove(id)}
      />
      <AddPath id="harv-project-path" label="Project folder to add" placeholder={example} onAdd={(path) => projectActions.add(path)} />
      {error && <Note warn>{error}</Note>}
      <TextSetting
        id="harv-projects-dir"
        label="New ones in"
        value={projectsDir}
        placeholder={defaultRoot}
        onSave={(v) => updateSettings({ projectsDir: v })}
      />
    </Sub>
  );
}

export function ProjectsSection() {
  return (
    <>
      <Group title="Projects">
        <Projects />
      </Group>
    </>
  );
}
