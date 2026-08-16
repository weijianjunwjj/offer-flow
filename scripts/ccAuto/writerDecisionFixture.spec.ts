import { describe, expect, it } from 'vitest';
import {
  classifyWriterDecisionAction,
  WRITER_DECISION_FIXTURE,
  WRITER_DECISION_FIXTURES,
  WRITER_READ_DECISION_FIXTURE,
  WRITER_SEARCH_DECISION_FIXTURE,
} from './__fixtures__/writerDecisionFixture';

describe('Provider-neutral Writer Decision Fixtures', () => {
  it('keeps the task, contract, tools, and search scope identical across all fixtures', () => {
    const baseline = WRITER_DECISION_FIXTURE;

    expect(WRITER_DECISION_FIXTURES).toHaveLength(3);
    for (const fixture of WRITER_DECISION_FIXTURES) {
      expect(fixture.phase).toBe('IMPLEMENT');
      expect(fixture.version).toBe('v1');
      expect(fixture.taskInput).toBe(baseline.taskInput);
      expect(fixture.userInstructions).toEqual(baseline.userInstructions);
      expect(fixture.systemInstructions).toEqual(baseline.systemInstructions);
      expect(fixture.availableTools).toEqual(baseline.availableTools);
      expect(fixture.repositorySearchRoots).toEqual(baseline.repositorySearchRoots);
    }
  });

  it('calibrates SEARCH when no target is confirmed', () => {
    const fixture = WRITER_SEARCH_DECISION_FIXTURE;

    expect(fixture.confirmedTargetPaths).toEqual([]);
    expect(fixture.allowedPaths).toEqual([]);
    expect(fixture.currentFiles).toEqual([]);
    expect(fixture.observationState).toEqual({
      discoveryRequired: true,
      targetConfirmed: false,
      targetContentAvailable: false,
      implementationContextSufficient: false,
    });
    expect(fixture.expectedNextActionClass).toBe('SEARCH');
  });

  it('calibrates READ when the target is approved but content is absent', () => {
    const fixture = WRITER_READ_DECISION_FIXTURE;

    expect(fixture.confirmedTargetPaths).toEqual(fixture.allowedPaths);
    expect(fixture.confirmedTargetPaths).toHaveLength(1);
    expect(fixture.currentFiles).toEqual([]);
    expect(fixture.observationState).toEqual({
      discoveryRequired: false,
      targetConfirmed: true,
      targetContentAvailable: false,
      implementationContextSufficient: false,
    });
    expect(fixture.expectedNextActionClass).toBe('READ');
  });

  it('preserves the existing WRITE fixture semantics when target content is sufficient', () => {
    const fixture = WRITER_DECISION_FIXTURE;
    const currentPaths = fixture.currentFiles.map(file => file.path);

    expect(fixture.id).toBe('writer-has-confirmed-target-and-current-content-v1');
    expect(fixture.confirmedTargetPaths).toEqual(fixture.allowedPaths);
    expect(currentPaths).toEqual(fixture.confirmedTargetPaths);
    expect(fixture.currentFiles.every(file => file.content.length > 0)).toBe(true);
    expect(fixture.observationState).toEqual({
      discoveryRequired: false,
      targetConfirmed: true,
      targetContentAvailable: true,
      implementationContextSufficient: true,
    });
    expect(fixture.previousObservations.map(item => item.kind)).toContain('DISCOVERY_COMPLETED');
    expect(fixture.observedNextAction?.actionClass).toBe('READ');
    expect(fixture.expectedNextActionClass).toBe('WRITE');
  });

  it('classifies decisions by tool class instead of exact response text', () => {
    expect(classifyWriterDecisionAction('read_file')).toBe('READ');
    expect(classifyWriterDecisionAction('grep')).toBe('SEARCH');
    expect(classifyWriterDecisionAction('glob')).toBe('SEARCH');
    expect(classifyWriterDecisionAction('edit_file')).toBe('WRITE');
    expect(classifyWriterDecisionAction('write_file')).toBe('WRITE');
    expect(classifyWriterDecisionAction(null)).toBe('FINAL');
  });

  it('contains no product-specific or provider/model-specific judgment', () => {
    const serialized = JSON.stringify(WRITER_DECISION_FIXTURES).toLowerCase();
    for (const forbiddenTerm of [
      'offerflow', 'radar', 'deepseek', 'gpt', 'grok', 'claude',
    ]) {
      expect(serialized).not.toContain(forbiddenTerm);
    }
  });
});
