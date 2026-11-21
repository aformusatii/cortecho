// The e2e simulator pool. Both the server that starts the FakeEchos and the
// tests import this file, so ports, MACs and the fixed key cannot drift apart.
//
// one/two   unkeyed, offered by discovery (DISCOVERY_EXTRA_TARGETS)
// keyed     has a key from the start: the "already secured" branch
// hidden    never scanned: only reachable by typing its address
export const FAKE_ECHO_PORTS = { one: 26101, two: 26102, keyed: 26103, hidden: 26104 } as const;

/** A fixed simulator key (base64 of 32 bytes). Never a real Echo's key. */
export const FAKE_ECHO_KEY = Buffer.alloc(32, 9).toString('base64');

/** Control endpoint of the simulator process (health + key reset). */
export const FAKE_ECHO_CONTROL_PORT = 26100;
