import 'dart:async';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/config.dart';
import '../../core/permissions.dart';
import '../../widgets/page.dart';
import '../pbx/pbx_api.dart';
import '../pbx/resource.dart';
import '../pbx/resource_page.dart';
import '../voicemail/voicemail_api.dart' show openRecordingProvider;
import 'file_source.dart';

/// Sends the file's bytes to the presigned URL the service handed out. The
/// service never sees the bytes (05 §4: presigned URLs only).
typedef UploadToStorage = Future<void> Function(
  String url,
  Uint8List bytes,
  String contentType,
);

final uploadToStorageProvider = Provider<UploadToStorage>((ref) {
  // Demo mode has no storage to send to.
  if (demoMode) return (_, _, _) async {};
  return (url, bytes, contentType) async {
    // A plain client: the presigned URL is the credential, so no bearer token,
    // no cookies, and no base URL.
    await Dio().put<void>(
      url,
      data: Stream.fromIterable([bytes]),
      options: Options(
        contentType: contentType,
        headers: {Headers.contentLengthHeader: bytes.length},
      ),
    );
  };
});

/// How the file chooser is opened; tests replace it.
final filePickerProvider = Provider<Future<PickedFile?> Function()>(
  (ref) => pickAudioFile,
);

const mediaKinds = {
  'prompt': 'Prompt (menus and announcements)',
  'moh': 'Hold music',
  'greeting': 'Voicemail greeting',
};

/// The media library: the table of recordings, an upload button, and a
/// refresh while any recording is still being checked and converted.
class MediaPage extends ConsumerStatefulWidget {
  const MediaPage({super.key});

  @override
  ConsumerState<MediaPage> createState() => _MediaPageState();
}

class _MediaPageState extends ConsumerState<MediaPage> {
  static const pollEvery = Duration(seconds: 3);
  Timer? _poll;

  @override
  void dispose() {
    _poll?.cancel();
    super.dispose();
  }

  /// Only a recording being converted changes by itself. One still waiting
  /// for its upload stays that way until the person acts.
  bool _working(List<Json> rows) =>
      rows.any((r) => r['status'] == 'processing');

  void _watch(List<Json> rows) {
    if (_working(rows)) {
      _poll ??= Timer.periodic(
        pollEvery,
        (_) => ref.invalidate(rowsProvider('media-assets')),
      );
    } else {
      _poll?.cancel();
      _poll = null;
    }
  }

  /// Opens a ready recording's audio in a new tab, where the browser plays it.
  Future<void> _play(Json row) async {
    final api = ref.read(pbxApiProvider);
    final open = ref.read(openRecordingProvider);
    final messenger = ScaffoldMessenger.of(context);
    if (api == null) return;
    try {
      await open(await api.mediaPlayUrl('${row['id']}'));
    } catch (e) {
      messenger.showSnackBar(
        SnackBar(content: Text('Could not play it: ${problemMessage(e)}')),
      );
    }
  }

  Future<void> _upload() async {
    await showDialog<bool>(
      context: context,
      builder: (_) => const UploadMediaDialog(),
    );
    // Even a cancelled or failed upload may have left a recording behind.
    ref.invalidate(rowsProvider('media-assets'));
  }

  @override
  Widget build(BuildContext context) {
    ref.listen(rowsProvider('media-assets'), (_, next) {
      final rows = next.asData?.value;
      if (rows != null) _watch(rows);
    });
    return ResourceView(
      def: mediaAssetsDef,
      // Only a converted recording has audio to play.
      rowActions: (context, ref, row) => [
        if (row['status'] == 'ready')
          IconButton(
            tooltip: 'Play',
            icon: const Icon(Icons.play_arrow),
            onPressed: () => _play(row),
          ),
      ],
      headerActions: [
        if (ref.watch(canProvider('media.manage')))
          FilledButton.icon(
            onPressed: _upload,
            icon: const Icon(Icons.upload_file),
            label: const Text('Upload recording'),
          ),
      ],
    );
  }
}

/// Chooses a file, names it, and runs the three steps: ask for an upload
/// address, send the bytes there, and tell the service it is done so it can
/// check and convert the recording.
class UploadMediaDialog extends ConsumerStatefulWidget {
  const UploadMediaDialog({super.key});

  @override
  ConsumerState<UploadMediaDialog> createState() => _UploadMediaDialogState();
}

class _UploadMediaDialogState extends ConsumerState<UploadMediaDialog> {
  final _label = TextEditingController();
  PickedFile? _file;
  String? _contentType;
  var _kind = 'prompt';
  String? _error;
  String? _step;

  bool get _busy => _step != null;

  @override
  void dispose() {
    _label.dispose();
    super.dispose();
  }

  Future<void> _choose() async {
    final file = await ref.read(filePickerProvider)();
    if (file == null || !mounted) return;
    final type = audioContentType(file.name, file.contentType);
    setState(() {
      _file = file;
      _contentType = type;
      _error = type == null
          ? 'That does not look like an audio file. Use WAV, MP3, OGG, M4A, or FLAC.'
          : null;
      if (_label.text.trim().isEmpty) {
        final dot = file.name.lastIndexOf('.');
        _label.text = dot > 0 ? file.name.substring(0, dot) : file.name;
      }
    });
  }

  Future<void> _send() async {
    final file = _file;
    final type = _contentType;
    final api = ref.read(pbxApiProvider);
    final label = _label.text.trim();
    if (file == null || type == null) {
      setState(() => _error = 'Choose an audio file first.');
      return;
    }
    if (label.isEmpty) {
      setState(() => _error = 'Give the recording a name.');
      return;
    }
    if (api == null) return;
    setState(() {
      _error = null;
      _step = 'Preparing…';
    });
    try {
      final created = await api.create('media-assets', {
        'kind': _kind,
        'label': label,
        'contentType': type,
      });
      final id = '${(created['asset'] as Map)['id']}';
      if (mounted) setState(() => _step = 'Uploading…');
      await ref.read(uploadToStorageProvider)(
        '${created['uploadUrl']}',
        file.bytes,
        type,
      );
      if (mounted) setState(() => _step = 'Finishing…');
      await api.call('POST', 'media-assets', id, 'finalize');
      if (mounted) Navigator.of(context).pop(true);
    } catch (e) {
      if (mounted) {
        setState(() {
          _step = null;
          _error = 'Could not upload: ${problemMessage(e)}';
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final file = _file;
    return AlertDialog(
      title: const Text('Upload recording'),
      content: SizedBox(
        width: 440,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            OutlinedButton.icon(
              onPressed: _busy ? null : _choose,
              icon: const Icon(Icons.folder_open),
              label: Text(file == null ? 'Choose a file' : file.name),
            ),
            if (file != null)
              Padding(
                padding: const EdgeInsets.only(top: 4),
                child: Text('${(file.bytes.length / 1024).ceil()} KB'),
              ),
            const SizedBox(height: 12),
            TextField(
              controller: _label,
              enabled: !_busy,
              decoration: const InputDecoration(labelText: 'Name'),
            ),
            const SizedBox(height: 8),
            DropdownButtonFormField<String>(
              initialValue: _kind,
              isExpanded: true,
              decoration: const InputDecoration(labelText: 'Used for'),
              items: [
                for (final e in mediaKinds.entries)
                  DropdownMenuItem(value: e.key, child: Text(e.value)),
              ],
              onChanged: _busy ? null : (v) => setState(() => _kind = v!),
            ),
            if (_step != null) ...[
              const SizedBox(height: 12),
              Row(
                children: [
                  const SizedBox(
                    width: 16,
                    height: 16,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  ),
                  const SizedBox(width: 8),
                  Text(_step!),
                ],
              ),
            ],
            if (_error != null) ...[
              const SizedBox(height: 12),
              ErrorText(_error!),
            ],
          ],
        ),
      ),
      actions: [
        TextButton(
          onPressed: _busy ? null : () => Navigator.of(context).pop(false),
          child: const Text('Cancel'),
        ),
        FilledButton(
          onPressed: _busy ? null : _send,
          child: const Text('Upload'),
        ),
      ],
    );
  }
}
