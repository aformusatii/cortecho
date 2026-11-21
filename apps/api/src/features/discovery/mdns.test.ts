import { describe, expect, it } from 'vitest';
import { parseMdnsTxt, sightingFromService } from './mdns.ts';

// The exact records hassmic prints in `print_mdns_to` (proto_esphome.c).
const UNKEYED = {
  mac: '020000000001',
  friendly_name: 'Echo Dot 2 cea6ae',
  version: '2025.5.0',
  platform: 'hassmic',
  network: 'wifi',
  api_encryption_supported: 'Noise_NNpsk0_25519_ChaChaPoly_SHA256',
};

const KEYED = {
  ...UNKEYED,
  api_encryption_supported: undefined,
  api_encryption: 'Noise_NNpsk0_25519_ChaChaPoly_SHA256',
};

describe('parseMdnsTxt', () => {
  it('reads an unkeyed hassmic service', () => {
    expect(parseMdnsTxt(UNKEYED)).toEqual({
      mac: '020000000001',
      friendlyName: 'Echo Dot 2 cea6ae',
      keyState: 'none',
      platform: 'hassmic',
    });
  });

  it('reads a keyed hassmic service, and prefers the key when both records are present', () => {
    expect(parseMdnsTxt(KEYED)).toMatchObject({ keyState: 'set', mac: '020000000001' });
    expect(
      parseMdnsTxt({ ...UNKEYED, api_encryption: 'Noise_NNpsk0_25519_ChaChaPoly_SHA256' }),
    ).toMatchObject({ keyState: 'set' });
  });

  it('accepts Buffer values, as multicast-dns decodes TXT records', () => {
    expect(
      parseMdnsTxt({
        mac: Buffer.from('020000000001'),
        friendly_name: Buffer.from('Echo Dot 2 cea6ae'),
        platform: Buffer.from('hassmic'),
        api_encryption_supported: Buffer.from('Noise_NNpsk0_25519_ChaChaPoly_SHA256'),
      }),
    ).toMatchObject({ mac: '020000000001', friendlyName: 'Echo Dot 2 cea6ae', keyState: 'none' });
  });

  it('normalises a colon-separated MAC and tolerates a missing friendly name', () => {
    expect(parseMdnsTxt({ mac: '02:00:00:00:00:01', platform: 'hassmic' })).toMatchObject({
      mac: '020000000001',
      friendlyName: '',
    });
  });

  it('requires platform=hassmic and rejects a missing/invalid MAC', () => {
    expect(parseMdnsTxt({ friendly_name: 'No MAC', platform: 'hassmic' })).toBeNull();
    expect(parseMdnsTxt({ mac: 'not-a-mac', platform: 'hassmic' })).toBeNull();
    expect(parseMdnsTxt({ mac: '020000000001' })).toBeNull();
    expect(parseMdnsTxt({ ...UNKEYED, platform: 'esphome' })).toBeNull();
    expect(parseMdnsTxt({ ...UNKEYED, platform: 'ESP32' })).toBeNull();
  });
});

describe('sightingFromService', () => {
  it('picks the private IPv4 address and keeps the service name and port', () => {
    expect(
      sightingFromService({
        name: 'fake-echo',
        port: 26053,
        addresses: ['fe80::1', '192.168.1.50', '192.168.1.51'],
        txt: UNKEYED,
      }),
    ).toEqual({
      name: 'fake-echo',
      host: '192.168.1.50',
      port: 26053,
      mac: '020000000001',
      friendlyName: 'Echo Dot 2 cea6ae',
      keyState: 'none',
    });
  });

  it('needs a private IPv4 address and a usable port', () => {
    expect(sightingFromService({ name: 'x', port: 26053, addresses: ['8.8.8.8'], txt: UNKEYED })).toBeNull();
    expect(sightingFromService({ name: 'x', port: 26053, txt: UNKEYED })).toBeNull();
    expect(sightingFromService({ name: 'x', port: 0, addresses: ['192.168.1.50'], txt: UNKEYED })).toBeNull();
  });

  it('rejects a service whose TXT is not a hassmic Echo', () => {
    expect(
      sightingFromService({
        name: 'x',
        port: 26053,
        addresses: ['192.168.1.50'],
        txt: { ...UNKEYED, platform: 'esphome' },
      }),
    ).toBeNull();
    expect(
      sightingFromService({ name: 'x', port: 26053, addresses: ['192.168.1.50'], txt: 'nope' }),
    ).toBeNull();
  });
});
