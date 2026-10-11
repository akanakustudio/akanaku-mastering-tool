// Project files (.akmaster, detailed design 13.5): a ZIP holding project.json, the song files
// and, optionally, the rendered audio. Used to back up work or move it to another browser/PC.
import type { WorkerClient } from "../../orchestrator/workerClient";
import type { DspMethods } from "../../workers/protocol";

export type ProjectKind = "single" | "album";
export type ProjectFile = { format: "akmaster"; formatVersion: 1; kind: ProjectKind; savedAt: string; includesRenders: boolean; workspace: unknown };

export async function downloadOpfsFile(path: string, name: string) {
  let dir = await navigator.storage.getDirectory();
  const parts = path.split("/");
  for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p);
  const file = await (await dir.getFileHandle(parts[parts.length - 1])).getFile();
  const url = URL.createObjectURL(file);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export async function exportProject(
  worker: WorkerClient<DspMethods>,
  kind: ProjectKind,
  workspace: unknown,
  sources: { id: string; file: File }[],
  renders: string[],
  baseName: string,
  onProgress?: (f: number) => void,
) {
  const project: ProjectFile = { format: "akmaster", formatVersion: 1, kind, savedAt: new Date().toISOString(), includesRenders: renders.length > 0, workspace };
  const fileName = `${baseName.replace(/[\\/:*?"<>|]/g, "_") || "project"}.akmaster`;
  const { path } = await worker.call("exportProject", { fileName, projectJson: JSON.stringify(project), sources, renders }, [], (_s, f) => onProgress?.(f));
  await downloadOpfsFile(path, fileName);
}

/** Reads a project file; rendered audio inside it is written straight back to OPFS by the worker. */
export async function importProject(worker: WorkerClient<DspMethods>, file: File, expected: ProjectKind, onProgress?: (f: number) => void) {
  const res = await worker.call("importProject", { file }, [], (_s, f) => onProgress?.(f));
  const project = JSON.parse(res.projectJson) as ProjectFile;
  if (project.format !== "akmaster") throw new Error("akanaku mastering のプロジェクトファイルではありません");
  if (project.kind !== expected) {
    throw new Error(project.kind === "album" ? "アルバムのプロジェクトです。「アルバム」タブで読み込んでください" : "シングルのプロジェクトです。「シングル」タブで読み込んでください");
  }
  return { project, sources: res.sources };
}
