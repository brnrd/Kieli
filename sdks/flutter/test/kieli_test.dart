import 'dart:convert';
import 'dart:io';
import 'package:test/test.dart';
import 'package:kieli/kieli.dart';

void main() {
  test('shared formatting fixtures, cache and bundled fallback', () async {
    final fixtures =
        jsonDecode(await File('../fixtures/messages.json').readAsString())
            as List;
    for (final raw in fixtures) {
      final fixture = raw as Map<String, dynamic>;
      final locale = fixture['locale'] as String;
      final directory = await Directory.systemTemp.createTemp('kieli-test');
      try {
        await File('${directory.path}/kieli-mobile-$locale-production.json')
            .writeAsString(jsonEncode({
          'endpoint':
              'https://copy.example.com/ota/mobile/$locale?channel=production',
          'etag': 'fixture',
          'bundle': fixture['bundle']
        }));
        final client = await KieliClient.open(
            baseUrl: Uri.parse('https://copy.example.com'),
            project: 'mobile',
            locale: locale,
            deliveryKey: 'a' * 32,
            cacheDirectory: directory);
        for (final check in fixture['checks'] as List) {
          expect(
              client.text(check[0] as String,
                  fallback: 'FALLBACK',
                  arguments: Map<String, String>.from(check[1] as Map)),
              check[2],
              reason: '$locale $check');
        }
      } finally {
        await directory.delete(recursive: true);
      }
    }
  });
  test('insecure endpoints are rejected', () async {
    final directory = await Directory.systemTemp.createTemp('kieli-test');
    try {
      for (final url in [
        'http://copy.example.com',
        'https://user:pass@copy.example.com',
        'https://copy.example.com/path'
      ]) {
        await expectLater(
            KieliClient.open(
                baseUrl: Uri.parse(url),
                project: 'mobile',
                locale: 'en',
                deliveryKey: 'a' * 32,
                cacheDirectory: directory),
            throwsArgumentError);
      }
    } finally {
      await directory.delete(recursive: true);
    }
  });
}
