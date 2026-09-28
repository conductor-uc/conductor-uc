import 'package:flutter/material.dart';

import '../../l10n/l10n.dart';

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

  /// A list of short words typed as one comma-separated line (codec names).
  textList,
}

/// Whether a field appears when creating, when editing, or both.
enum FieldScope { both, create, edit }

/// What a text field holds, so the form can check it as it is typed and
/// send it the way the service wants it (S9-04).
enum FieldFormat {
  /// A phone number, typed the way people write it and sent as E.164.
  phone,

  /// A phone's MAC address, with or without separators.
  mac,

  /// One email address.
  email,
}

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
    this.status = false,
    this.allowEmpty = false,
    this.emptyLabel,
    this.needs,
    this.notForReseller = false,
    this.format,
    this.advanced = false,
    this.choiceHelp = const {},
    this.placeholder,
    this.check,
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

  /// Shown in the table as a status chip (a processing state), not plain text.
  final bool status;

  /// A required text whose empty value is meaningful (sent as an empty string,
  /// not left out): a catch-all pattern.
  final bool allowEmpty;

  /// What the table shows for an empty value instead of a dash.
  final String? emptyLabel;

  /// A permission the field's own data needs (the people a person can be linked
  /// to are read with `user.manage`); the form leaves the field out without it.
  final String? needs;

  /// Left out of the form for a reseller, who may not set it (the service
  /// refuses it): linking a person gives them an extension's voicemail and
  /// call history, which are private to the tenant.
  final bool notForReseller;

  /// Checked and normalized by the form ([FieldFormat]).
  final FieldFormat? format;

  /// Folded away under "Advanced settings": most people never change it.
  final bool advanced;

  /// One line explaining each choice, shown under it in the list and under
  /// the field once chosen.
  final Map<String, String> choiceHelp;

  /// An example of what to type, shown in the empty field.
  final String? placeholder;

  /// A rule across fields ("the last slot comes after the first"): given
  /// every value in the form, the problem with this field, or null.
  final String? Function(Map<String, Object?> values)? check;

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
    this.permission,
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

  /// The permission that lets someone change these rows; without it the page
  /// is for reading. Null when there is no single one.
  final String? permission;

  /// One line naming a row, for pickers and confirmations.
  final String Function(Map<String, dynamic> row)? title;
  final String? blurb;

  /// [key] as an ICU select value (`ring-groups` → `ring_groups`), for the
  /// per-resource phrases in the ARB ("New ring group").
  String get selectKey => key.replaceAll('-', '_');

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

/// Every kind of place a call can be sent (a number's destination, where an
/// unanswered call goes), in the order people choose from.
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

/// The destinations in plain words, with a line explaining each (S9-08).
Map<String, String> _destinationLabels(AppLocalizations l) => {
  'extension': l.destExtension,
  'ring_group': l.destRingGroup,
  'flow': l.destFlow,
  'queue': l.destQueue,
  'conference': l.destConference,
  'voicemail': l.destVoicemail,
};

Map<String, String> _destinationHelp(AppLocalizations l) => {
  'extension': l.destExtensionHelp,
  'ring_group': l.destRingGroupHelp,
  'flow': l.destFlowHelp,
  'queue': l.destQueueHelp,
  'conference': l.destConferenceHelp,
  'voicemail': l.destVoicemailHelp,
};

/// A choice of destination and the picker for which one, as a pair.
List<Field> _destinationFields(
  AppLocalizations l, {
  required String typeKey,
  required String idKey,
  required String label,
  String? help,
  bool required = false,
  bool showInList = false,
  bool advanced = false,
}) => [
  Field(
    typeKey,
    label,
    FieldKind.choice,
    required: required,
    choices: destinationTypes,
    choiceLabels: _destinationLabels(l),
    choiceHelp: _destinationHelp(l),
    help: help,
    showInList: showInList,
    advanced: advanced,
  ),
  Field(
    idKey,
    l.destWhich,
    FieldKind.dynamicRef,
    required: required,
    refByField: typeKey,
    refMap: destinationResource,
    showInList: showInList,
    advanced: advanced,
  ),
];

// The definitions below are getters, not constants: their words come from
// the ARB in the viewer's language (S9-08, D-018), so they are built when
// asked for. They are cheap to build.

ResourceDef get extensionsDef {
  final l = currentL10n;
  return ResourceDef(
    key: 'extensions',
    permission: 'extension.manage',
    singular: l.extSingular,
    plural: l.extPlural,
    icon: Icons.dialpad_outlined,
    blurb: l.extBlurb,
    title: _extensionTitle,
    fields: [
      Field(
        'number',
        l.extNumber,
        FieldKind.text,
        required: true,
        showInList: true,
        help: l.extNumberHelp,
      ),
      Field(
        'displayName',
        l.extName,
        FieldKind.text,
        required: true,
        showInList: true,
        help: l.extNameHelp,
      ),
      Field(
        'voicemailEnabled',
        l.extVoicemail,
        FieldKind.toggle,
        showInList: true,
        initial: false,
        help: l.extVoicemailHelp,
      ),
      Field(
        'emergencyLocationId',
        l.extLocation,
        FieldKind.ref,
        required: true,
        ref: 'emergency-locations',
        showInList: true,
        help: l.extLocationHelp,
      ),
      Field(
        'userId',
        l.extUser,
        FieldKind.ref,
        ref: 'users',
        needs: 'user.read',
        notForReseller: true,
        help: l.extUserHelp,
      ),
      Field('callerIdName', l.extCallerIdName, FieldKind.text, advanced: true),
      Field(
        'callerIdNumber',
        l.extCallerIdNumber,
        FieldKind.text,
        format: FieldFormat.phone,
        advanced: true,
        help: l.extCallerIdNumberHelp,
      ),
    ],
  );
}

String _extensionTitle(Map<String, dynamic> row) =>
    '${row['number']} · ${row['displayName']}';

ResourceDef get didsDef {
  final l = currentL10n;
  return ResourceDef(
    key: 'dids',
    permission: 'did.manage',
    singular: l.didSingular,
    plural: l.didPlural,
    icon: Icons.phone_outlined,
    blurb: l.didBlurb,
    title: _didTitle,
    fields: [
      Field(
        'e164',
        l.didNumber,
        FieldKind.text,
        required: true,
        showInList: true,
        format: FieldFormat.phone,
        help: l.didNumberHelp,
      ),
      ..._destinationFields(
        l,
        typeKey: 'destinationType',
        idKey: 'destinationId',
        label: l.didAnswers,
        required: true,
        showInList: true,
      ),
      Field(
        'trunkId',
        l.didTrunk,
        FieldKind.ref,
        required: true,
        ref: 'trunks',
        showInList: true,
        help: l.didTrunkHelp,
      ),
    ],
  );
}

String _didTitle(Map<String, dynamic> row) => '${row['e164']}';

ResourceDef get ringGroupsDef {
  final l = currentL10n;
  return ResourceDef(
    key: 'ring-groups',
    permission: 'group.manage',
    singular: l.rgSingular,
    plural: l.rgPlural,
    icon: Icons.groups_outlined,
    blurb: l.rgBlurb,
    fields: [
      Field(
        'label',
        l.fieldName,
        FieldKind.text,
        required: true,
        showInList: true,
      ),
      Field(
        'memberExtensionIds',
        l.rgMembers,
        FieldKind.refList,
        required: true,
        ref: 'extensions',
        showInList: true,
        help: l.rgMembersHelp,
      ),
      Field(
        'strategy',
        l.rgStrategy,
        FieldKind.choice,
        required: true,
        choices: const ['simultaneous', 'sequential', 'round_robin', 'random'],
        choiceLabels: {
          'simultaneous': l.rgSimultaneous,
          'sequential': l.rgSequential,
          'round_robin': l.rgRoundRobin,
          'random': l.rgRandom,
        },
        choiceHelp: {
          'simultaneous': l.rgSimultaneousHelp,
          'sequential': l.rgSequentialHelp,
          'round_robin': l.rgRoundRobinHelp,
          'random': l.rgRandomHelp,
        },
        showInList: true,
        initial: 'simultaneous',
      ),
      Field(
        'ringTimeoutSeconds',
        l.rgRingFor,
        FieldKind.integer,
        required: true,
        min: 5,
        max: 300,
        initial: 20,
        showInList: true,
        help: l.rgRingForHelp,
      ),
      ..._destinationFields(
        l,
        typeKey: 'noAnswerDestinationType',
        idKey: 'noAnswerDestinationId',
        label: l.noAnswerType,
        help: l.noAnswerTypeHelp,
      ),
    ],
  );
}

ResourceDef get queuesDef {
  final l = currentL10n;
  return ResourceDef(
    key: 'queues',
    permission: 'queue.manage',
    singular: l.qSingular,
    plural: l.qPlural,
    icon: Icons.queue_outlined,
    blurb: l.qBlurb,
    fields: [
      Field(
        'label',
        l.fieldName,
        FieldKind.text,
        required: true,
        showInList: true,
      ),
      Field(
        'strategy',
        l.qStrategy,
        FieldKind.choice,
        required: true,
        choices: const [
          'longest-idle-agent',
          'ring-all',
          'round-robin',
          'top-down',
          'agent-with-least-talk-time',
          'agent-with-fewest-calls',
          'sequentially-by-agent-order',
          'random',
        ],
        choiceLabels: {
          'ring-all': l.qRingAll,
          'longest-idle-agent': l.qLongestIdle,
          'round-robin': l.qRoundRobin,
          'top-down': l.qTopDown,
          'agent-with-least-talk-time': l.qLeastTalk,
          'agent-with-fewest-calls': l.qFewestCalls,
          'sequentially-by-agent-order': l.qSequential,
          'random': l.qRandom,
        },
        choiceHelp: {
          'ring-all': l.qRingAllHelp,
          'longest-idle-agent': l.qLongestIdleHelp,
          'round-robin': l.qRoundRobinHelp,
          'top-down': l.qTopDownHelp,
          'agent-with-least-talk-time': l.qLeastTalkHelp,
          'agent-with-fewest-calls': l.qFewestCallsHelp,
          'sequentially-by-agent-order': l.qSequentialHelp,
          'random': l.qRandomHelp,
        },
        initial: 'longest-idle-agent',
        showInList: true,
      ),
      Field(
        'maxWaitSeconds',
        l.qMaxWait,
        FieldKind.integer,
        required: true,
        min: 0,
        initial: 300,
        showInList: true,
        help: l.qMaxWaitHelp,
      ),
      ..._destinationFields(
        l,
        typeKey: 'noAgentDestinationType',
        idKey: 'noAgentDestinationId',
        label: l.qNoAgentType,
        help: l.qNoAgentTypeHelp,
      ),
      Field(
        'mohMediaAssetId',
        l.qMusic,
        FieldKind.ref,
        ref: 'media-assets',
        help: l.qMusicHelp,
      ),
      Field(
        'announcePosition',
        l.qAnnounce,
        FieldKind.toggle,
        required: true,
        initial: false,
      ),
      Field(
        'announceFrequencySeconds',
        l.qAnnounceEvery,
        FieldKind.integer,
        min: 1,
        advanced: true,
      ),
    ],
  );
}

ResourceDef get agentsDef {
  final l = currentL10n;
  return ResourceDef(
    key: 'agents',
    permission: 'queue.manage',
    singular: l.agSingular,
    plural: l.agPlural,
    icon: Icons.headset_mic_outlined,
    blurb: l.agBlurb,
    fields: [
      Field(
        'extensionId',
        l.agExtension,
        FieldKind.ref,
        required: true,
        ref: 'extensions',
        showInList: true,
      ),
      Field(
        'wrapUpSeconds',
        l.agWrapUp,
        FieldKind.integer,
        min: 0,
        showInList: true,
        help: l.agWrapUpHelp,
      ),
      Field(
        'maxNoAnswer',
        l.agMaxNoAnswer,
        FieldKind.integer,
        min: 0,
        showInList: true,
        advanced: true,
      ),
      Field(
        'rejectDelaySeconds',
        l.agRejectDelay,
        FieldKind.integer,
        min: 0,
        advanced: true,
      ),
    ],
  );
}

ResourceDef get conferenceRoomsDef {
  final l = currentL10n;
  return ResourceDef(
    key: 'conference-rooms',
    permission: 'conference_room.manage',
    singular: l.crSingular,
    plural: l.crPlural,
    icon: Icons.video_call_outlined,
    blurb: l.crBlurb,
    fields: [
      Field(
        'label',
        l.fieldName,
        FieldKind.text,
        required: true,
        showInList: true,
      ),
      Field(
        'number',
        l.crNumber,
        FieldKind.text,
        required: true,
        showInList: true,
        help: l.crNumberHelp,
      ),
      Field('pin', l.crPin, FieldKind.text, writeOnly: true, help: l.crPinHelp),
      Field(
        'maxMembers',
        l.crMaxMembers,
        FieldKind.integer,
        required: true,
        min: 2,
        initial: 20,
        showInList: true,
      ),
      Field(
        'video',
        l.crVideo,
        FieldKind.toggle,
        showInList: true,
        initial: false,
      ),
      Field('layout', l.crLayout, FieldKind.text, advanced: true),
    ],
  );
}

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

ResourceDef get schedulesDef {
  final l = currentL10n;
  return ResourceDef(
    key: 'schedules',
    permission: 'schedule.manage',
    singular: l.schSingular,
    plural: l.schPlural,
    icon: Icons.schedule_outlined,
    blurb: l.schBlurb,
    fields: [
      Field(
        'label',
        l.fieldName,
        FieldKind.text,
        required: true,
        showInList: true,
      ),
      Field(
        'timezone',
        l.schTimezone,
        FieldKind.choice,
        required: true,
        choices: commonTimezones,
        initial: 'UTC',
        showInList: true,
      ),
      Field(
        'rules',
        l.schRules,
        FieldKind.weeklyHours,
        showInList: true,
        initial: const [
          {
            'days': [1, 2, 3, 4, 5],
            'start': '09:00',
            'end': '17:00',
          },
        ],
      ),
      Field(
        'holidays',
        l.schHolidays,
        FieldKind.dateList,
        showInList: true,
        initial: const <Map<String, dynamic>>[],
      ),
    ],
  );
}

ResourceDef get parkingLotsDef {
  final l = currentL10n;
  return ResourceDef(
    key: 'parking-lots',
    permission: 'parking_lot.manage',
    singular: l.plSingular,
    plural: l.plPlural,
    icon: Icons.local_parking_outlined,
    blurb: l.plBlurb,
    fields: [
      Field(
        'label',
        l.fieldName,
        FieldKind.text,
        required: true,
        showInList: true,
      ),
      Field(
        'slotStart',
        l.plFirst,
        FieldKind.integer,
        required: true,
        min: 0,
        showInList: true,
        initial: 701,
      ),
      Field(
        'slotEnd',
        l.plLast,
        FieldKind.integer,
        required: true,
        min: 0,
        showInList: true,
        initial: 720,
        check: _lastSlotAfterFirst,
      ),
      Field(
        'timeoutSeconds',
        l.plTimeout,
        FieldKind.integer,
        required: true,
        min: 1,
        initial: 120,
        help: l.plTimeoutHelp,
      ),
      ..._destinationFields(
        l,
        typeKey: 'returnDestinationType',
        idKey: 'returnDestinationId',
        label: l.plReturnType,
        advanced: true,
      ),
    ],
  );
}

ResourceDef get emergencyLocationsDef {
  final l = currentL10n;
  return ResourceDef(
    key: 'emergency-locations',
    permission: 'emergency_location.manage',
    singular: l.elSingular,
    plural: l.elPlural,
    icon: Icons.local_hospital_outlined,
    blurb: l.elBlurb,
    fields: [
      Field(
        'label',
        l.fieldName,
        FieldKind.text,
        required: true,
        showInList: true,
        help: l.elNameHelp,
      ),
      Field(
        'addressLine1',
        l.elAddress,
        FieldKind.text,
        required: true,
        showInList: true,
      ),
      Field('addressLine2', l.elAddress2, FieldKind.text),
      Field('city', l.elCity, FieldKind.text, required: true, showInList: true),
      Field(
        'state',
        l.elState,
        FieldKind.text,
        required: true,
        showInList: true,
      ),
      Field('postalCode', l.elPostal, FieldKind.text, required: true),
      Field(
        'country',
        l.elCountry,
        FieldKind.text,
        required: true,
        initial: 'US',
        help: l.elCountryHelp,
      ),
    ],
  );
}

ResourceDef get mediaAssetsDef {
  final l = currentL10n;
  return ResourceDef(
    key: 'media-assets',
    permission: 'media.manage',
    singular: l.mdSingular,
    plural: l.mdPlural,
    icon: Icons.library_music_outlined,
    blurb: l.mdBlurb,
    readOnly: true,
    fields: [
      Field('label', l.fieldName, FieldKind.text, showInList: true),
      Field('kind', l.mdKind, FieldKind.text, showInList: true),
      Field(
        'status',
        l.mdStatus,
        FieldKind.text,
        showInList: true,
        status: true,
      ),
      Field('contentType', l.mdType, FieldKind.text, showInList: true),
    ],
  );
}

/// A carrier connection. A reseller adds and edits its tenants' trunks; a
/// DID picks one. Its registration status and IP allowlist have their own
/// dialog (`trunks_page.dart`).
ResourceDef get trunksDef {
  final l = currentL10n;
  return ResourceDef(
    key: 'trunks',
    permission: 'trunk.manage',
    singular: l.trSingular,
    plural: l.trPlural,
    icon: Icons.cable_outlined,
    blurb: l.trBlurb,
    fields: [
      Field(
        'name',
        l.fieldName,
        FieldKind.text,
        required: true,
        showInList: true,
      ),
      Field(
        'authMode',
        l.trAuth,
        FieldKind.choice,
        required: true,
        choices: const ['register', 'ip', 'both'],
        choiceLabels: {
          'register': l.trRegister,
          'ip': l.trIp,
          'both': l.trBoth,
        },
        choiceHelp: {
          'register': l.trRegisterHelp,
          'ip': l.trIpHelp,
          'both': l.trBothHelp,
        },
        initial: 'register',
        showInList: true,
      ),
      Field('host', l.trHost, FieldKind.text, required: true, showInList: true),
      Field(
        'username',
        l.trUsername,
        FieldKind.text,
        check: _usernameForRegister,
      ),
      Field(
        'secret',
        l.trSecret,
        FieldKind.text,
        secret: true,
        writeOnly: true,
        help: l.trSecretHelp,
      ),
      Field(
        'port',
        l.trPort,
        FieldKind.integer,
        required: true,
        min: 1,
        max: 65535,
        initial: 5060,
        showInList: true,
        advanced: true,
      ),
      Field(
        'transport',
        l.trTransport,
        FieldKind.choice,
        required: true,
        choices: const ['udp', 'tcp', 'tls'],
        choiceLabels: {'udp': 'UDP', 'tcp': 'TCP', 'tls': l.trTls},
        initial: 'udp',
        showInList: true,
        advanced: true,
      ),
      Field('fromDomain', l.trFromDomain, FieldKind.text, advanced: true),
      Field(
        'codecs',
        l.trCodecs,
        FieldKind.textList,
        required: true,
        initial: const ['PCMU', 'PCMA'],
        help: l.trCodecsHelp,
        showInList: true,
        advanced: true,
      ),
      Field(
        'maxChannels',
        l.trMaxChannels,
        FieldKind.integer,
        min: 1,
        help: l.trMaxChannelsHelp,
        advanced: true,
      ),
    ],
  );
}

/// How a tenant's outbound calls pick a trunk: the first route, lowest
/// priority number first, whose prefix the dialed number starts with. The
/// service lists them in that order, so changing the priority reorders them.
ResourceDef get outboundRoutesDef {
  final l = currentL10n;
  return ResourceDef(
    key: 'outbound-routes',
    permission: 'trunk.manage',
    singular: l.orSingular,
    plural: l.orPlural,
    icon: Icons.call_made_outlined,
    blurb: l.orBlurb,
    title: _outboundRouteTitle,
    fields: [
      Field(
        'priority',
        l.orPriority,
        FieldKind.integer,
        required: true,
        min: 0,
        initial: 10,
        showInList: true,
        help: l.orPriorityHelp,
      ),
      Field(
        'pattern',
        l.orPattern,
        FieldKind.text,
        required: true,
        allowEmpty: true,
        emptyLabel: l.orPatternEmpty,
        showInList: true,
        help: l.orPatternHelp,
      ),
      Field(
        'trunkIds',
        l.orTrunks,
        FieldKind.refList,
        required: true,
        ref: 'trunks',
        showInList: true,
        help: l.orTrunksHelp,
      ),
      Field(
        'strip',
        l.orStrip,
        FieldKind.integer,
        min: 0,
        initial: 0,
        nullable: false,
        showInList: true,
        help: l.orStripHelp,
        advanced: true,
      ),
      Field(
        'prepend',
        l.orPrepend,
        FieldKind.text,
        showInList: true,
        help: l.orPrependHelp,
        advanced: true,
      ),
    ],
  );
}

String _outboundRouteTitle(Map<String, dynamic> row) {
  final pattern = row['pattern'];
  return pattern is String && pattern.isNotEmpty
      ? currentL10n.orTitlePattern(pattern)
      : currentL10n.orTitleAll;
}

/// Callflows are listed by their own page; the definition exists so other
/// resources can pick a flow as a destination.
ResourceDef get flowsDef => ResourceDef(
  key: 'flows',
  permission: 'callflow.edit',
  singular: currentL10n.cfSingular,
  plural: currentL10n.cfPlural,
  icon: Icons.account_tree_outlined,
  readOnly: true,
  fields: const [],
);

/// A desk phone that sets itself up from the platform. The phone's own
/// settings are the extension it registers as; its address (MAC) is fixed once
/// it exists, because the phone asks for its file by that name.
ResourceDef get devicesDef {
  final l = currentL10n;
  return ResourceDef(
    key: 'devices',
    permission: 'extension.manage',
    singular: l.dvSingular,
    plural: l.dvPlural,
    icon: Icons.phone_android_outlined,
    blurb: l.dvBlurb,
    title: _deviceTitle,
    fields: [
      Field(
        'mac',
        l.dvMac,
        FieldKind.text,
        required: true,
        showInList: true,
        scope: FieldScope.create,
        format: FieldFormat.mac,
        help: l.dvMacHelp,
      ),
      Field(
        'extensionId',
        l.dvExtension,
        FieldKind.ref,
        required: true,
        ref: 'extensions',
        showInList: true,
        help: l.dvExtensionHelp,
      ),
      Field('model', l.dvModel, FieldKind.text, showInList: true),
      Field(
        'label',
        l.dvLabel,
        FieldKind.text,
        showInList: true,
        help: l.dvLabelHelp,
      ),
    ],
  );
}

String _deviceTitle(Map<String, dynamic> row) {
  final label = row['label'];
  if (label is String && label.isNotEmpty) return label;
  return '${row['mac']}';
}

List<ResourceDef> get allResources => [
  extensionsDef,
  devicesDef,
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
  outboundRoutesDef,
  flowsDef,
];

/// The people of the tenant, for a picker (an extension's owner). Not a PBX
/// resource: they are read from identity (`/v1/orgs/{id}/users`), so this is
/// not in [allResources].
ResourceDef get peopleDef => ResourceDef(
  key: 'users',
  singular: currentL10n.pdSingular,
  plural: currentL10n.pdPlural,
  icon: Icons.people_outline,
  fields: const [],
  title: _personTitle,
);

String _personTitle(Map<String, dynamic> row) {
  final name = row['displayName'];
  final email = row['email'];
  if (name is String && name.isNotEmpty) {
    return email is String && email.isNotEmpty ? '$name ($email)' : name;
  }
  return '${email ?? row['id']}';
}

ResourceDef resourceByKey(String key) =>
    key == 'users' ? peopleDef : allResources.firstWhere((r) => r.key == key);

/// A parking lot's slots run from the first to the last.
String? _lastSlotAfterFirst(Map<String, Object?> values) {
  final first = values['slotStart'];
  final last = values['slotEnd'];
  return first is int && last is int && last < first
      ? currentL10n.formLastSlotAfterFirst
      : null;
}

/// A trunk that registers with the carrier signs in with a username.
String? _usernameForRegister(Map<String, Object?> values) {
  final username = values['username'];
  return values['authMode'] != 'ip' && (username == null || username == '')
      ? currentL10n.formTrunkNeedsUsername
      : null;
}
