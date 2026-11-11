import { test } from 'node:test'
import { strict as assert } from 'node:assert'

import { settings } from './constants.js'
import { loadConfig, RpcConfigurationError } from './environment.js'

test('RPC_URL is mandatory and has no public-provider fallback', () => {
  const previous = process.env.RPC_URL
  delete process.env.RPC_URL
  try {
    assert.throws(loadConfig, {
      name: 'RpcConfigurationError',
      message: 'RPC_URL is required',
    })
  } finally {
    if (previous === undefined) {
      delete process.env.RPC_URL
    } else {
      process.env.RPC_URL = previous
    }
  }
  for (const value of ['', ' ', '\n\t']) {
    assert.throws(() => loadConfig(value), /RPC_URL is required/)
  }
})

test('invalid RPC URLs fail without leaking their credentials', () => {
  for (const value of [
    'invalid-secret-token',
    'https://',
    'file:///secret-token',
    'ws://localhost/secret-token',
  ]) {
    assert.throws(
      () => loadConfig(value),
      error => {
        assert.ok(error instanceof RpcConfigurationError)
        assert.equal(error.message, 'RPC_URL must be a valid HTTP or HTTPS URL')
        assert.equal('input' in error, false)
        assert.equal('cause' in error, false)
        return true
      },
    )
  }
})

test('valid RPC URLs use the fixed code settings', () => {
  for (const rpcUrl of [
    'http://localhost:8545',
    'https://rpc.example/v2/key',
  ]) {
    assert.deepEqual(loadConfig(` ${rpcUrl} `), { ...settings, rpcUrl })
  }
})
