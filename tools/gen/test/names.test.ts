import { describe, expect, it } from 'vitest';

import {
  InvalidNameError,
  pluralize,
  toCamelCase,
  toPascalCase,
  toSnakeCase,
  validateDomain,
  validateEntityName,
  validateServiceName,
} from '../src/names.js';

describe('validateServiceName', () => {
  it('accepts a kebab-case name ending in -service', () => {
    expect(validateServiceName('billing-service')).toBe('billing-service');
    expect(validateServiceName('pbx-config-service')).toBe('pbx-config-service');
  });

  it('rejects a name not ending in -service', () => {
    expect(() => validateServiceName('billing')).toThrow(InvalidNameError);
    expect(() => validateServiceName('billing')).toThrow(/ending in/);
  });

  it('rejects uppercase and underscores', () => {
    expect(() => validateServiceName('Billing-Service')).toThrow(InvalidNameError);
    expect(() => validateServiceName('billing_service')).toThrow(InvalidNameError);
  });

  it('rejects a name with a double hyphen or a trailing hyphen', () => {
    expect(() => validateServiceName('billing--service')).toThrow(InvalidNameError);
    expect(() => validateServiceName('-service')).toThrow(InvalidNameError);
  });
});

describe('validateEntityName', () => {
  it('accepts a lowercase kebab-case name', () => {
    expect(validateEntityName('widget')).toBe('widget');
    expect(validateEntityName('call-flow')).toBe('call-flow');
  });

  it('rejects uppercase, spaces, and underscores', () => {
    for (const bad of ['Widget', 'call flow', 'call_flow', '']) {
      expect(() => validateEntityName(bad)).toThrow(InvalidNameError);
    }
  });
});

describe('validateDomain', () => {
  it('accepts every domain from 05 §5', () => {
    for (const domain of [
      'org',
      'identity',
      'pbx',
      'trunk',
      'callflow',
      'call',
      'cdr',
      'recording',
      'voicemail',
      'sms',
      'fax',
      'audit',
    ]) {
      expect(validateDomain(domain)).toBe(domain);
    }
  });

  it('rejects a domain that is not in the catalog', () => {
    expect(() => validateDomain('billing')).toThrow(InvalidNameError);
    expect(() => validateDomain('billing')).toThrow(/not an event domain/);
  });

  it('names the accepted domains in the error', () => {
    expect(() => validateDomain('billing')).toThrow(/org, identity, pbx/);
  });
});

describe('toPascalCase', () => {
  it('capitalizes each hyphen-separated part', () => {
    expect(toPascalCase('example-service')).toBe('ExampleService');
    expect(toPascalCase('pbx-config')).toBe('PbxConfig');
    expect(toPascalCase('widget')).toBe('Widget');
  });
});

describe('toCamelCase', () => {
  it('lowercases the first character of the Pascal form', () => {
    expect(toCamelCase('example-service')).toBe('exampleService');
    expect(toCamelCase('widget')).toBe('widget');
  });
});

describe('toSnakeCase', () => {
  it('replaces hyphens with underscores', () => {
    expect(toSnakeCase('pbx-config')).toBe('pbx_config');
    expect(toSnakeCase('widget')).toBe('widget');
  });
});

describe('pluralize', () => {
  it('adds s to the common case', () => {
    expect(pluralize('widget')).toBe('widgets');
    expect(pluralize('extension')).toBe('extensions');
  });

  it('adds es after s, sh, ch, x, z', () => {
    expect(pluralize('class')).toBe('classes');
    expect(pluralize('box')).toBe('boxes');
  });

  it('replaces a consonant + y with ies', () => {
    expect(pluralize('policy')).toBe('policies');
  });

  it('leaves a vowel + y alone before adding s', () => {
    expect(pluralize('day')).toBe('days');
  });
});
