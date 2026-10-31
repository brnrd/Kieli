import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:intl/intl.dart';

typedef Json = Map<String, dynamic>;

/// Native Flutter (iOS/Android) client. Call refresh() on launch, then rebuild UI.
class KeyloClient {
  final Uri _endpoint;
  final String _project, _locale, _deliveryKey;
  final File _cache;
  Json? _current;
  Future<bool>? _pending;
  KeyloClient._(this._endpoint, this._project, this._locale, this._deliveryKey,
      this._cache);

  static Future<KeyloClient> open(
      {required Uri baseUrl,
      required String project,
      required String locale,
      required String deliveryKey,
      required Directory cacheDirectory,
      String channel = 'production'}) async {
    if (baseUrl.scheme != 'https' ||
        baseUrl.host.isEmpty ||
        baseUrl.userInfo.isNotEmpty ||
        baseUrl.hasQuery ||
        baseUrl.hasFragment ||
        !['', '/'].contains(baseUrl.path) ||
        !RegExp(r'^[a-z0-9][a-z0-9-]{0,47}$').hasMatch(project) ||
        !RegExp(r'^[A-Za-z0-9-]{2,50}$').hasMatch(locale) ||
        !['production', 'preview'].contains(channel) ||
        !RegExp(r'^[A-Za-z0-9_.-]{20,200}$').hasMatch(deliveryKey)) {
      throw ArgumentError(
          'Use an HTTPS Keylo origin, valid project, locale, channel and delivery key.');
    }
    await cacheDirectory.create(recursive: true);
    final endpoint = baseUrl
        .resolve('/ota/$project/$locale')
        .replace(queryParameters: {'channel': channel});
    final client = KeyloClient._(endpoint, project, locale, deliveryKey,
        File('${cacheDirectory.path}/keylo-$project-$locale-$channel.json'));
    try {
      if (await client._cache.length() <= 3 * 1024 * 1024) {
        final saved = jsonDecode(await client._cache.readAsString()) as Json;
        if (saved['endpoint'] == endpoint.toString() &&
            client._valid(saved['bundle'] as Json)) client._current = saved;
      }
    } catch (_) {/* Start with bundled strings. */}
    return client;
  }

  /// False leaves the previous cache intact (including offline and 304 responses).
  Future<bool> refresh() async {
    if (_pending != null) return _pending!;
    final pending = _fetch();
    _pending = pending;
    try {
      return await pending;
    } finally {
      _pending = null;
    }
  }

  Future<bool> _fetch() async {
    final http = HttpClient()..connectionTimeout = const Duration(seconds: 10);
    final deadline =
        Timer(const Duration(seconds: 15), () => http.close(force: true));
    try {
      final request =
          await http.getUrl(_endpoint).timeout(const Duration(seconds: 10));
      request.followRedirects = false;
      request.headers
          .set(HttpHeaders.authorizationHeader, 'Bearer $_deliveryKey');
      if (_current?['etag'] case final String etag when etag.isNotEmpty)
        request.headers.set(HttpHeaders.ifNoneMatchHeader, etag);
      final response =
          await request.close().timeout(const Duration(seconds: 10));
      if (response.statusCode != 200 ||
          response.contentLength > 2 * 1024 * 1024) return false;
      final bytes = <int>[];
      await for (final chunk in response.timeout(const Duration(seconds: 10))) {
        if (bytes.length + chunk.length > 2 * 1024 * 1024) return false;
        bytes.addAll(chunk);
      }
      final bundle = jsonDecode(utf8.decode(bytes)) as Json;
      if (!_valid(bundle)) return false;
      final saved = <String, dynamic>{
        'endpoint': _endpoint.toString(),
        'etag': response.headers.value(HttpHeaders.etagHeader) ?? '',
        'bundle': bundle
      };
      final temporary = File('${_cache.path}.tmp');
      await temporary.writeAsString(jsonEncode(saved), flush: true);
      await temporary.rename(_cache.path);
      _current = saved;
      return true;
    } catch (_) {
      return false;
    } finally {
      deadline.cancel();
      http.close(force: true);
    }
  }

  bool _valid(Json bundle) =>
      bundle['schema'] == 1 &&
      bundle['project'] == _project &&
      bundle['locale'] == _locale &&
      (bundle['messages'] as Map).length <= 50000 &&
      bundle['rules'] is Map;

  /// Numeric arguments are decimal strings, e.g. {'count': '3'}.
  String text(String key,
      {required String fallback, Map<String, String> arguments = const {}}) {
    try {
      final bundle = _current!['bundle'] as Json;
      return _render(
          bundle['messages'][key]['nodes'] as List, arguments, bundle, null, 0);
    } catch (_) {
      return fallback;
    }
  }

  String _render(List nodes, Map<String, String> args, Json bundle,
      double? pound, int depth) {
    if (depth > 20) throw const FormatException('Message too deep');
    final result = StringBuffer();
    for (final raw in nodes) {
      final node = raw as Json;
      switch (node['type']) {
        case 'text':
          result.write(node['value'] as String);
        case 'argument':
          final value = args[node['value']];
          if (value == null) throw const FormatException('Missing argument');
          result.write(value);
        case 'pound':
          if (pound == null) throw const FormatException('Missing count');
          result.write(
              (NumberFormat.decimalPattern(_locale.replaceAll('-', '_'))
                    ..maximumFractionDigits = 9)
                  .format(pound));
        case 'select':
          final value = args[node['value']];
          if (value == null) throw const FormatException('Missing argument');
          final options = node['options'] as Json;
          result.write(_render((options[value] ?? options['other']) as List,
              args, bundle, pound, depth + 1));
        case 'plural':
          final rawNumber = args[node['value']]!;
          if (!RegExp(r'^-?[0-9]{1,13}(\.[0-9]{1,9})?$').hasMatch(rawNumber))
            throw const FormatException('Invalid count');
          final number = double.parse(rawNumber);
          if (!number.isFinite || number.abs() > 1e12)
            throw const FormatException('Invalid count');
          final value = number - ((node['offset'] as num?)?.toDouble() ?? 0);
          final options = node['options'] as Json;
          final exact = options.keys
              .where((key) =>
                  key.startsWith('=') &&
                  double.tryParse(key.substring(1)) == number)
              .firstOrNull;
          final category = exact ??
              _category(
                  value,
                  bundle['rules']
                          [node['ordinal'] == true ? 'ordinal' : 'cardinal']
                      as Json);
          result.write(_render((options[category] ?? options['other']) as List,
              args, bundle, value, depth + 1));
        default:
          throw const FormatException('Unsupported message');
      }
      if (result.length > 100000)
        throw const FormatException('Message too large');
    }
    return result.toString();
  }

  String _category(double input, Json rules) {
    final number = input.abs();
    final decimal = number
        .toStringAsFixed(9)
        .replaceFirst(RegExp(r'0+$'), '')
        .replaceFirst(RegExp(r'\.$'), '');
    final fraction = decimal.contains('.') ? decimal.split('.').last : '';
    final trimmed = fraction.replaceFirst(RegExp(r'0+$'), '');
    final operands = <String, double>{
      'n': number,
      'i': number.floorToDouble(),
      'v': fraction.length.toDouble(),
      'w': trimmed.length.toDouble(),
      'f': double.tryParse(fraction) ?? 0,
      't': double.tryParse(trimmed) ?? 0,
      'e': 0,
      'c': 0
    };
    for (final form in ['zero', 'one', 'two', 'few', 'many']) {
      final groups = rules[form] as List?;
      if (groups != null &&
          groups.any((group) => (group as List).every((raw) {
                final rule = raw as Json;
                var value = operands[rule['operand']]!;
                final mod = rule['mod'] as num;
                if (mod > 0) value %= mod;
                final match = value.truncateToDouble() == value &&
                    (rule['ranges'] as List).any((range) =>
                        value >= (range[0] as num) &&
                        value <= (range[1] as num));
                return rule['not'] == true ? !match : match;
              }))) return form;
    }
    return 'other';
  }
}
