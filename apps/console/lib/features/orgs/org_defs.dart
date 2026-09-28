import 'package:flutter/material.dart';

import '../../l10n/l10n.dart';
import '../pbx/resource.dart';

List<Field> _orgFields(AppLocalizations l) => [
  Field(
    'slug',
    l.orgFieldSlug,
    FieldKind.text,
    required: true,
    scope: FieldScope.create,
    help: l.orgFieldSlugHelp,
  ),
  Field('name', l.fieldName, FieldKind.text, required: true),
  Field(
    'adminEmail',
    l.orgFieldAdminEmail,
    FieldKind.text,
    required: true,
    scope: FieldScope.create,
    help: l.orgFieldAdminEmailHelp,
  ),
  Field(
    'adminDisplayName',
    l.orgFieldAdminName,
    FieldKind.text,
    required: true,
    scope: FieldScope.create,
  ),
  Field(
    'adminPassword',
    l.orgFieldAdminPassword,
    FieldKind.text,
    required: true,
    secret: true,
    scope: FieldScope.create,
    help: l.orgFieldAdminPasswordHelp,
  ),
  Field(
    'timezone',
    l.orgFieldTimezone,
    FieldKind.text,
    scope: FieldScope.edit,
    nullable: false,
    help: l.orgFieldTimezoneHelp,
  ),
  Field(
    'country',
    l.orgFieldCountry,
    FieldKind.text,
    scope: FieldScope.edit,
    nullable: false,
    help: l.orgFieldCountryHelp,
  ),
];

/// The create and edit forms for the org tree. They are not `allResources`:
/// those are tenant-scoped PBX resources reached under `/v1/tenants/{id}/`,
/// while these live at `/v1/resellers` and `/v1/tenants/{id}`.
ResourceDef get resellerDef {
  final l = currentL10n;
  return ResourceDef(
    key: 'resellers',
    permission: 'reseller.manage',
    singular: l.orgResellerSingular,
    plural: l.orgResellerPlural,
    icon: Icons.storefront_outlined,
    fields: _orgFields(l),
  );
}

ResourceDef get tenantDef {
  final l = currentL10n;
  return ResourceDef(
    key: 'tenants',
    permission: 'tenant.manage',
    singular: l.orgTenantSingular,
    plural: l.orgTenantPlural,
    icon: Icons.apartment_outlined,
    fields: _orgFields(l),
  );
}
