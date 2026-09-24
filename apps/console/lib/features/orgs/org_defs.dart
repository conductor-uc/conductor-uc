import 'package:flutter/material.dart';

import '../pbx/resource.dart';

const _slug = Field(
  'slug',
  'Short name',
  FieldKind.text,
  required: true,
  scope: FieldScope.create,
  help: 'Lowercase letters, digits and hyphens, at least two characters. It cannot be changed later.',
);
const _name = Field('name', 'Name', FieldKind.text, required: true);
const _adminEmail = Field(
  'adminEmail',
  'Admin email',
  FieldKind.text,
  required: true,
  scope: FieldScope.create,
  help: 'The first administrator, who signs in with this address.',
);
const _adminName = Field(
  'adminDisplayName',
  'Admin name',
  FieldKind.text,
  required: true,
  scope: FieldScope.create,
);
const _adminPassword = Field(
  'adminPassword',
  'Admin password',
  FieldKind.text,
  required: true,
  secret: true,
  scope: FieldScope.create,
  help: 'At least 12 characters.',
);
const _timezone = Field(
  'timezone',
  'Time zone',
  FieldKind.text,
  scope: FieldScope.edit,
  nullable: false,
  help: 'For example America/Chicago.',
);
const _country = Field(
  'country',
  'Country',
  FieldKind.text,
  scope: FieldScope.edit,
  nullable: false,
  help: 'Two-letter code, for example US.',
);

/// The create and edit forms for the org tree. They are not `allResources`:
/// those are tenant-scoped PBX resources reached under `/v1/tenants/{id}/`,
/// while these live at `/v1/resellers` and `/v1/tenants/{id}`.
const resellerDef = ResourceDef(
  key: 'resellers',
  permission: 'reseller.manage',
  singular: 'Reseller',
  plural: 'Resellers',
  icon: Icons.storefront_outlined,
  fields: [
    _slug,
    _name,
    _adminEmail,
    _adminName,
    _adminPassword,
    _timezone,
    _country,
  ],
);

const tenantDef = ResourceDef(
  key: 'tenants',
  permission: 'tenant.manage',
  singular: 'Tenant',
  plural: 'Tenants',
  icon: Icons.apartment_outlined,
  fields: [
    _slug,
    _name,
    _adminEmail,
    _adminName,
    _adminPassword,
    _timezone,
    _country,
  ],
);
