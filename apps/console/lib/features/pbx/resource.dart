import 'package:flutter/material.dart';

/// How a field is edited and displayed.
enum FieldKind {
  text,
  integer,
  toggle,

  /// One of [Field.choices].
  choice,

  /// The id of a row in another resource ([Field.ref]).
  ref,

  /// A list of ids of rows in another resource.
  refList,

  /// An id whose resource depends on another field's value ([Field.refByField]).
  dynamicRef,

  /// A list of weekly open windows: days, and from when to when.
  weeklyHours,

  /// A list of dates, each with an optional name.
  dateList,
}

/// Whether a field appears when creating, when editing, or both.
enum FieldScope { both, create, edit }

/// One property of a resource. The set of fields mirrors the service's request
/// schema; `test/contract_test.dart` checks that against the OpenAPI snapshot.
class Field {
  const Field(
    this.key,
    this.label,
    this.kind, {
    this.required = false,
    this.choices = const [],
    this.choiceLabels = const {},
    this.ref,
    this.refByField,
    this.refMap = const {},
    this.showInList = false,
    this.help,
    this.writeOnly = false,
    this.min,
    this.max,
    this.initial,
    this.scope = FieldScope.both,
    this.secret = false,
    this.nullable = true,
  });

  final String key;
  final String label;
  final FieldKind kind;
  final bool required;
  final List<String> choices;

  /// What to show for a choice whose stored value reads badly.
  final Map<String, String> choiceLabels;

  /// The resource whose rows a [FieldKind.ref] or [FieldKind.refList] picks from.
  final String? ref;

  /// For [FieldKind.dynamicRef]: the sibling field whose value picks the resource.
  final String? refByField;
  final Map<String, String> refMap;
  final bool showInList;
  final String? help;

  /// Sent to the server but never returned (a PIN); blank on edit means unchanged.
  final bool writeOnly;
  final int? min;
  final int? max;
  final Object? initial;
  final FieldScope scope;

  /// Typed with the characters hidden (a password).
  final bool secret;

  /// Whether the service accepts null to clear it. When false, an empty value
  /// on edit is left out of the request rather than sent as null.
  final bool nullable;

  bool inScope({required bool editing}) =>
      scope == FieldScope.both ||
      (editing ? scope == FieldScope.edit : scope == FieldScope.create);
}

/// A tenant-owned PBX resource: where it lives, what it is called, and the
/// fields that make up its form and its table.
class ResourceDef {
  const ResourceDef({
    required this.key,
    required this.singular,
    required this.plural,
    required this.icon,
    required this.fields,
    this.readOnly = false,
    this.title,
    this.blurb,
  });

  /// The path segment under `/v1/tenants/{tenantId}/`.
  final String key;
  final String singular;
  final String plural;
  final IconData icon;
  final List<Field> fields;

  /// No create or edit from the console (deleting still works).
  final bool readOnly;

  /// One line naming a row, for pickers and confirmations.
  final String Function(Map<String, dynamic> row)? title;
  final String? blurb;

  String titleOf(Map<String, dynamic> row) {
    final custom = title;
    if (custom != null) return custom(row);
    for (final k in const ['label', 'name', 'displayName', 'e164', 'number']) {
      final v = row[k];
      if (v is String && v.isNotEmpty) return v;
    }
    return '${row['id']}';
  }
}

const destinationTypes = [
  'extension',
  'ring_group',
  'flow',
  'queue',
  'conference',
  'voicemail',
];

/// Where a destination type's id comes from.
const destinationResource = {
  'extension': 'extensions',
  'ring_group': 'ring-groups',
  'flow': 'flows',
  'queue': 'queues',
  'conference': 'conference-rooms',
  'voicemail': 'extensions',
};

const extensionsDef = ResourceDef(
  key: 'extensions',
  singular: 'Extension',
  plural: 'Extensions',
  icon: Icons.dialpad_outlined,
  blurb: 'Internal numbers that phones and softphones register as.',
  title: _extensionTitle,
  fields: [
    Field('number', 'Number', FieldKind.text, required: true, showInList: true),
    Field(
      'displayName',
      'Name',
      FieldKind.text,
      required: true,
      showInList: true,
    ),
    Field('callerIdName', 'Caller ID name', FieldKind.text),
    Field('callerIdNumber', 'Caller ID number', FieldKind.text),
    Field(
      'voicemailEnabled',
      'Voicemail',
      FieldKind.toggle,
      showInList: true,
      initial: false,
    ),
    Field(
      'emergencyLocationId',
      'Emergency location',
      FieldKind.ref,
      required: true,
      ref: 'emergency-locations',
      showInList: true,
      help: 'Where emergency services are sent for calls from this extension.',
    ),
  ],
);

String _extensionTitle(Map<String, dynamic> row) =>
    '${row['number']} · ${row['displayName']}';

const didsDef = ResourceDef(
  key: 'dids',
  singular: 'Phone number',
  plural: 'Phone numbers',
  icon: Icons.phone_outlined,
  blurb: 'Numbers callers dial, and where each one rings.',
  title: _didTitle,
  fields: [
    Field(
      'e164',
      'Number',
      FieldKind.text,
      required: true,
      showInList: true,
      help: 'E.164, for example +14155550100.',
    ),
    Field('trunkId', 'Trunk', FieldKind.ref, required: true, ref: 'trunks'),
    Field(
      'destinationType',
      'Rings',
      FieldKind.choice,
      required: true,
      choices: destinationTypes,
      showInList: true,
    ),
    Field(
      'destinationId',
      'Destination',
      FieldKind.dynamicRef,
      required: true,
      refByField: 'destinationType',
      refMap: destinationResource,
      showInList: true,
    ),
  ],
);

String _didTitle(Map<String, dynamic> row) => '${row['e164']}';

const _noAnswerFields = [
  Field(
    'noAnswerDestinationType',
    'If no answer',
    FieldKind.choice,
    choices: destinationTypes,
    help: 'Optional. Where the call goes when nobody picks up.',
  ),
  Field(
    'noAnswerDestinationId',
    'Then send to',
    FieldKind.dynamicRef,
    refByField: 'noAnswerDestinationType',
    refMap: destinationResource,
  ),
];

const ringGroupsDef = ResourceDef(
  key: 'ring-groups',
  singular: 'Ring group',
  plural: 'Ring groups',
  icon: Icons.groups_outlined,
  blurb: 'Ring several extensions for one call.',
  fields: [
    Field('label', 'Name', FieldKind.text, required: true, showInList: true),
    Field(
      'strategy',
      'Strategy',
      FieldKind.choice,
      required: true,
      choices: ['simultaneous', 'sequential', 'round_robin', 'random'],
      showInList: true,
      initial: 'simultaneous',
    ),
    Field(
      'memberExtensionIds',
      'Members',
      FieldKind.refList,
      required: true,
      ref: 'extensions',
      showInList: true,
      help: 'At least one.',
    ),
    Field(
      'ringTimeoutSeconds',
      'Ring for (seconds)',
      FieldKind.integer,
      required: true,
      min: 5,
      max: 300,
      initial: 20,
      showInList: true,
    ),
    ..._noAnswerFields,
  ],
);

const queuesDef = ResourceDef(
  key: 'queues',
  singular: 'Queue',
  plural: 'Queues',
  icon: Icons.queue_outlined,
  blurb: 'Hold callers until an agent is free.',
  fields: [
    Field('label', 'Name', FieldKind.text, required: true, showInList: true),
    Field(
      'strategy',
      'Strategy',
      FieldKind.choice,
      required: true,
      choices: [
        'ring-all',
        'longest-idle-agent',
        'round-robin',
        'top-down',
        'agent-with-least-talk-time',
        'agent-with-fewest-calls',
        'sequentially-by-agent-order',
        'random',
      ],
      initial: 'longest-idle-agent',
      showInList: true,
    ),
    Field(
      'mohMediaAssetId',
      'Hold music',
      FieldKind.ref,
      ref: 'media-assets',
      help: 'A ready media asset. Blank uses the default.',
    ),
    Field(
      'maxWaitSeconds',
      'Longest wait (seconds)',
      FieldKind.integer,
      required: true,
      min: 0,
      initial: 300,
      showInList: true,
    ),
    Field(
      'announcePosition',
      'Announce position',
      FieldKind.toggle,
      required: true,
      initial: false,
    ),
    Field(
      'announceFrequencySeconds',
      'Announce every (seconds)',
      FieldKind.integer,
      min: 1,
    ),
    Field(
      'noAgentDestinationType',
      'If no agent',
      FieldKind.choice,
      choices: destinationTypes,
      help: 'Optional. Where callers go when no agent is available.',
    ),
    Field(
      'noAgentDestinationId',
      'Then send to',
      FieldKind.dynamicRef,
      refByField: 'noAgentDestinationType',
      refMap: destinationResource,
    ),
  ],
);

const agentsDef = ResourceDef(
  key: 'agents',
  singular: 'Agent',
  plural: 'Agents',
  icon: Icons.headset_mic_outlined,
  blurb: 'Extensions that take queue calls.',
  fields: [
    Field(
      'extensionId',
      'Extension',
      FieldKind.ref,
      required: true,
      ref: 'extensions',
      showInList: true,
    ),
    Field(
      'maxNoAnswer',
      'Give up after (misses)',
      FieldKind.integer,
      min: 0,
      showInList: true,
    ),
    Field(
      'wrapUpSeconds',
      'Wrap-up (seconds)',
      FieldKind.integer,
      min: 0,
      showInList: true,
    ),
    Field(
      'rejectDelaySeconds',
      'Retry delay (seconds)',
      FieldKind.integer,
      min: 0,
    ),
  ],
);

const conferenceRoomsDef = ResourceDef(
  key: 'conference-rooms',
  singular: 'Conference room',
  plural: 'Conference rooms',
  icon: Icons.video_call_outlined,
  fields: [
    Field('label', 'Name', FieldKind.text, required: true, showInList: true),
    Field('number', 'Number', FieldKind.text, required: true, showInList: true),
    Field(
      'pin',
      'PIN',
      FieldKind.text,
      writeOnly: true,
      help: 'Optional. Leave blank on edit to keep the current PIN.',
    ),
    Field('video', 'Video', FieldKind.toggle, showInList: true, initial: false),
    Field('layout', 'Video layout', FieldKind.text),
    Field(
      'maxMembers',
      'Most people',
      FieldKind.integer,
      required: true,
      min: 2,
      initial: 20,
      showInList: true,
    ),
  ],
);

/// Time zones offered where a form asks for one. The service accepts any IANA
/// name; these are the common ones.
const commonTimezones = [
  'UTC',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Phoenix',
  'America/Anchorage',
  'Pacific/Honolulu',
  'America/Toronto',
  'America/Sao_Paulo',
  'Europe/London',
  'Europe/Paris',
  'Europe/Berlin',
  'Europe/Madrid',
  'Europe/Athens',
  'Africa/Johannesburg',
  'Asia/Dubai',
  'Asia/Kolkata',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Australia/Sydney',
  'Pacific/Auckland',
];

const schedulesDef = ResourceDef(
  key: 'schedules',
  singular: 'Schedule',
  plural: 'Schedules',
  icon: Icons.schedule_outlined,
  blurb: 'Open hours and holidays, to route calls differently after hours.',
  fields: [
    Field('label', 'Name', FieldKind.text, required: true, showInList: true),
    Field(
      'timezone',
      'Time zone',
      FieldKind.choice,
      required: true,
      choices: commonTimezones,
      initial: 'UTC',
      showInList: true,
    ),
    Field(
      'rules',
      'Open hours',
      FieldKind.weeklyHours,
      showInList: true,
      initial: [
        {
          'days': [1, 2, 3, 4, 5],
          'start': '09:00',
          'end': '17:00',
        },
      ],
    ),
    Field(
      'holidays',
      'Holidays',
      FieldKind.dateList,
      showInList: true,
      initial: <Map<String, dynamic>>[],
    ),
  ],
);

const parkingLotsDef = ResourceDef(
  key: 'parking-lots',
  singular: 'Parking lot',
  plural: 'Parking lots',
  icon: Icons.local_parking_outlined,
  fields: [
    Field('label', 'Name', FieldKind.text, required: true, showInList: true),
    Field(
      'slotStart',
      'First slot',
      FieldKind.integer,
      required: true,
      min: 0,
      showInList: true,
      initial: 701,
    ),
    Field(
      'slotEnd',
      'Last slot',
      FieldKind.integer,
      required: true,
      min: 0,
      showInList: true,
      initial: 720,
    ),
    Field(
      'timeoutSeconds',
      'Return after (seconds)',
      FieldKind.integer,
      required: true,
      min: 1,
      initial: 120,
    ),
    Field(
      'returnDestinationType',
      'Then send to',
      FieldKind.choice,
      choices: destinationTypes,
    ),
    Field(
      'returnDestinationId',
      'Destination',
      FieldKind.dynamicRef,
      refByField: 'returnDestinationType',
      refMap: destinationResource,
    ),
  ],
);

const emergencyLocationsDef = ResourceDef(
  key: 'emergency-locations',
  singular: 'Emergency location',
  plural: 'Emergency locations',
  icon: Icons.local_hospital_outlined,
  blurb: 'Dispatchable addresses. Every extension needs one.',
  fields: [
    Field('label', 'Name', FieldKind.text, required: true, showInList: true),
    Field(
      'addressLine1',
      'Address',
      FieldKind.text,
      required: true,
      showInList: true,
    ),
    Field('addressLine2', 'Address line 2', FieldKind.text),
    Field('city', 'City', FieldKind.text, required: true, showInList: true),
    Field('state', 'State', FieldKind.text, required: true, showInList: true),
    Field('postalCode', 'Postal code', FieldKind.text, required: true),
    Field('country', 'Country', FieldKind.text, required: true, initial: 'US'),
  ],
);

const mediaAssetsDef = ResourceDef(
  key: 'media-assets',
  singular: 'Media file',
  plural: 'Media',
  icon: Icons.library_music_outlined,
  blurb: 'Prompts, hold music, and greetings. Upload arrives with the media screens.',
  readOnly: true,
  fields: [
    Field('label', 'Name', FieldKind.text, showInList: true),
    Field('kind', 'Kind', FieldKind.text, showInList: true),
    Field('status', 'Status', FieldKind.text, showInList: true),
    Field('contentType', 'Type', FieldKind.text, showInList: true),
  ],
);

/// Reseller-managed; a tenant only picks from it (a DID's trunk).
const trunksDef = ResourceDef(
  key: 'trunks',
  singular: 'Trunk',
  plural: 'Trunks',
  icon: Icons.cable_outlined,
  readOnly: true,
  fields: [],
);

/// Callflows are listed by their own page; the definition exists so other
/// resources can pick a flow as a destination.
const flowsDef = ResourceDef(
  key: 'flows',
  singular: 'Call flow',
  plural: 'Call flows',
  icon: Icons.account_tree_outlined,
  readOnly: true,
  fields: [],
);

const allResources = <ResourceDef>[
  extensionsDef,
  didsDef,
  ringGroupsDef,
  queuesDef,
  agentsDef,
  conferenceRoomsDef,
  parkingLotsDef,
  schedulesDef,
  emergencyLocationsDef,
  mediaAssetsDef,
  trunksDef,
  flowsDef,
];

ResourceDef resourceByKey(String key) =>
    allResources.firstWhere((r) => r.key == key);
