import {
  resolve as resolveConfiguration,
  type CompanyManifest,
  type EffectiveConfiguration,
} from '../core/cwm';
import {
  problemAt,
  problemWithoutPosition,
  type Problem,
  type ProjectRecord,
  type Workspace,
} from '../infra/cwm';

export interface ResolveOutcome {
  readonly effective: EffectiveConfiguration | null;
  readonly problems: readonly Problem[];
}

/** Skladanie konfiguracji jednego projektu na danych z dysku; wspolne dla `resolve` i `doctor`. */
export async function resolveRecord(
  workspace: Workspace,
  record: ProjectRecord,
): Promise<ResolveOutcome> {
  const project = record.loaded;
  if (!project.ok) return { effective: null, problems: project.problems };
  if (!workspace.global.ok) return { effective: null, problems: workspace.global.problems };

  const problems: Problem[] = [];
  const companyId = project.value.metadata.company;
  const company = workspace.companies.get(companyId);
  if (company === undefined) {
    return {
      effective: null,
      problems: [
        problemAt(
          project.file,
          project.text,
          'metadata.company',
          `Firma "${companyId}" nie istnieje w ${workspace.layout.companiesDir}.`,
        ),
      ],
    };
  }
  if (!company.ok) return { effective: null, problems: company.problems };

  const importSources: CompanyManifest[] = [];
  for (const entry of project.value.spec.imports) {
    const source = workspace.companies.get(entry.from);
    if (source?.ok === true) importSources.push(source.value);
    else if (source !== undefined) problems.push(...source.problems);
  }

  let parentCompany: string | undefined;
  if (record.dir !== null) {
    const parent = await workspace.index.enclosing(record.dir, false);
    problems.push(...parent.problems);
    const parentLoaded = parent.record?.loaded;
    if (parentLoaded?.ok === true) parentCompany = parentLoaded.value.metadata.company;
    else if (parentLoaded !== undefined) problems.push(...parentLoaded.problems);
  }
  if (problems.length > 0) return { effective: null, problems };

  const result = resolveConfiguration(
    workspace.global.value,
    company.value,
    project.value,
    workspace.registry,
    { importSources, ...(parentCompany === undefined ? {} : { parentCompany }) },
  );
  if (result.ok) return { effective: result.value, problems: [] };

  const sources = {
    project: { file: project.file, text: project.text },
    company: { file: company.file, text: company.text },
    global: { file: workspace.global.file, text: workspace.global.text },
  };
  return {
    effective: null,
    problems: result.errors.map((error): Problem => {
      const match = /^(project|company|global)\.(.+)$/.exec(error.path);
      const scope = match?.[1] as keyof typeof sources | undefined;
      if (scope !== undefined && match?.[2] !== undefined) {
        const source = sources[scope];
        return problemAt(source.file, source.text, match[2], error.message);
      }
      return problemWithoutPosition(project.file, error.path, error.message);
    }),
  };
}
