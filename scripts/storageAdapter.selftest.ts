import { createAsyncStores } from '../src/app/stores';
import { MemoryStorageDriver } from '../src/storage';
import type { SQLiteClient } from '../src/storage';
import type { JobRecord, JobSeekerProfile } from '../src/storage';

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean): void {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}`);
  }
}

function section(title: string): void {
  console.log(`\n=== ${title} ===`);
}

function profile(): JobSeekerProfile {
  return {
    resumeText: 'resume',
    projectExperience: 'project',
    targetCity: 'Suzhou',
    targetRole: 'Frontend Developer',
    expectedSalary: '20-25K',
    acceptOutsourcing: false,
    acceptOvertime: true,
    jobSearchFocus: 'growth',
    weaknessNote: '',
  };
}

class FakeSQLiteClient implements SQLiteClient {
  private storedProfile: JobSeekerProfile | null = null;
  private readonly jobs = new Map<string, JobRecord>();

  async getProfile(): Promise<JobSeekerProfile | null> {
    return this.storedProfile;
  }

  async saveProfile(nextProfile: JobSeekerProfile): Promise<JobSeekerProfile> {
    this.storedProfile = structuredClone(nextProfile);
    return structuredClone(nextProfile);
  }

  async clearProfile(): Promise<void> {
    this.storedProfile = null;
  }

  async createJob(job: JobRecord): Promise<JobRecord> {
    this.jobs.set(job.id, structuredClone(job));
    return structuredClone(job);
  }

  async getJob(id: string): Promise<JobRecord | null> {
    const job = this.jobs.get(id);
    return job ? structuredClone(job) : null;
  }

  async listJobs(): Promise<JobRecord[]> {
    return [...this.jobs.values()]
      .map((job) => structuredClone(job))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async updateJob(job: JobRecord): Promise<JobRecord> {
    this.jobs.set(job.id, structuredClone(job));
    return structuredClone(job);
  }

  async deleteJob(id: string): Promise<void> {
    this.jobs.delete(id);
  }
}

async function pause(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 2));
}

async function main(): Promise<void> {
  section('localStorage async backend');

  const localStores = createAsyncStores({
    backend: 'localStorage',
    storageDriver: new MemoryStorageDriver(),
  });
  const localProfile = await localStores.config.saveProfile(profile());
  check('localStorage backend is selected explicitly', localStores.backend === 'localStorage');
  check('localStorage profile round-trips', localProfile.targetCity === 'Suzhou');
  check('localStorage getProfile reads saved profile', (await localStores.config.getProfile())?.targetRole === 'Frontend Developer');

  const localOldJob = await localStores.jobs.createJob({ company: 'Old Co', role: 'FE' });
  await pause();
  const localNewJob = await localStores.jobs.createJob({ company: 'New Co', role: 'FE' });
  check('localStorage createJob fills default communication status', localNewJob.communicationStatus === 'not_contacted');
  check('localStorage listJobs sorts by updatedAt desc', (await localStores.jobs.listJobs())[0]?.id === localNewJob.id);

  const localPatched = await localStores.jobs.updateJob(localOldJob.id, {
    aiRawResult: 'raw result',
    parseStatus: 'parsed',
  });
  const localPatchedAgain = await localStores.jobs.updateJob(localOldJob.id, {
    matchScore: '91',
  });
  check('localStorage updateJob keeps patch semantics', localPatchedAgain.aiRawResult === localPatched.aiRawResult);
  await localStores.jobs.deleteJob(localOldJob.id);
  check('localStorage deleteJob removes job', await localStores.jobs.getJob(localOldJob.id) === null);

  section('SQLite async backend');

  const sqliteStores = createAsyncStores({
    backend: 'sqlite',
    sqliteClient: new FakeSQLiteClient(),
  });
  const sqliteProfile = await sqliteStores.config.saveProfile(profile());
  check('SQLite backend is selected explicitly', sqliteStores.backend === 'sqlite');
  check('SQLite profile round-trips', sqliteProfile.targetCity === 'Suzhou');
  await sqliteStores.config.clearProfile();
  check('SQLite clearProfile removes profile', await sqliteStores.config.getProfile() === null);

  const sqliteOldJob = await sqliteStores.jobs.createJob({ company: 'SQLite Old', role: 'FE' });
  await pause();
  const sqliteNewJob = await sqliteStores.jobs.createJob({ company: 'SQLite New', role: 'FE' });
  check('SQLite createJob fills complete default fields', sqliteNewJob.companyInput.sizeTier === 'unknown');
  check('SQLite listJobs sorts by updatedAt desc', (await sqliteStores.jobs.listJobs())[0]?.id === sqliteNewJob.id);

  const sqliteRawJob = await sqliteStores.jobs.updateJob(sqliteOldJob.id, {
    aiRawResult: 'sqlite raw',
    parseStatus: 'parsed',
  });
  const sqlitePatched = await sqliteStores.jobs.updateJob(sqliteOldJob.id, {
    matchScore: '88',
  });
  check('SQLite updateJob patch preserves existing data_json fields', sqlitePatched.aiRawResult === sqliteRawJob.aiRawResult);
  await sqliteStores.jobs.deleteJob(sqliteOldJob.id);
  check('SQLite deleteJob removes job', await sqliteStores.jobs.getJob(sqliteOldJob.id) === null);

  section('Summary');
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
