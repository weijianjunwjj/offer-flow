import type { HostSnapshotIdentity, HostSnapshotV3Manifest, JsonPrimitive } from '@weijianjunwjj/nova-wing/host-snapshot';

export const OFFERFLOW_HOST_DATA_FORMAT = 'offerflow.host-data.v3' as const;
export const OFFERFLOW_COMPONENT_NAME = 'offerflow' as const;
export const OFFERFLOW_COMPONENT_FORMAT = 'offerflow.snapshot.v3' as const;
export const OFFERFLOW_SNAPSHOT_VERSION = 3 as const;
export const HOST_SNAPSHOT_V3_DATA_FILE = 'offerflow-host.snapshot.v3.json' as const;
export const HOST_SNAPSHOT_V3_MANIFEST_FILE = 'offerflow-host.manifest.v3.json' as const;

export interface SnapshotTableData {
  name: string;
  primaryKey: string[];
  columns: string[];
  rows: Array<Record<string, JsonPrimitive>>;
}

export interface SnapshotComponentData {
  component: string;
  tables: SnapshotTableData[];
}

export interface HostSnapshotV3Data {
  format: typeof OFFERFLOW_HOST_DATA_FORMAT;
  snapshotVersion: typeof OFFERFLOW_SNAPSHOT_VERSION;
  createdAt: string;
  host: HostSnapshotIdentity;
  components: SnapshotComponentData[];
  hostManifestDigest: string;
}

export interface VerifiedHostSnapshotV3 {
  data: HostSnapshotV3Data;
  manifest: HostSnapshotV3Manifest;
}

export interface HostSnapshotV3ExportReport {
  status: 'planned' | 'exported';
  snapshotVersion: 3;
  databaseSchemaVersion: number;
  componentCount: number;
  tableCount: number;
  hostManifestDigest: string;
  componentDigests: Record<string, string>;
}

export interface HostSnapshotV3VerifyReport {
  status: 'verified';
  snapshotVersion: 3;
  componentCount: number;
  tableCount: number;
  hostManifestDigest: string;
}

export interface RestoreCandidateReport {
  status: 'planned' | 'candidate-ready';
  snapshotVersion: 3;
  databaseSchemaVersion: number;
  componentCount: number;
  tableCount: number;
  hostManifestDigest: string;
  novaWingCoreRevision: number;
  integrity: 'not-run' | 'ok';
  foreignKeyViolationCount: 0;
  renameProbe: 'not-run' | 'passed';
}
