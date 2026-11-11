import { z } from 'zod'

import type { FundState } from './types.js'

const zeroAddress = `0x${'0'.repeat(40)}`
const maximumUint = (1n << 256n) - 1n
const address = z.string().regex(/^0x[0-9a-f]{40}$/)
const uint = z
  .string()
  .refine(
    value => /^(0|[1-9][0-9]*)$/.test(value) && BigInt(value) <= maximumUint,
    { message: 'Expected a canonical uint256 string', abort: true },
  )
const positiveUint = uint.refine(value => BigInt(value) > 0n, { abort: true })

const claim = z.strictObject({
  miner: address,
  shiftId: positiveUint,
  claimId: positiveUint,
  oreAmount: positiveUint,
})

const shift = z.strictObject({
  funded: z.boolean(),
  price: uint,
  dollar: address,
  fundedAt: uint,
  oreAmount: uint,
  dollarScale: uint,
  currentClaimId: uint,
})

export const fundStateSchema: z.ZodType<FundState> = z
  .strictObject({
    magicOre: z.strictObject({
      name: z.string(),
      owner: address,
      symbol: z.string(),
      decimals: z.literal(18),
      totalSupply: uint,
      holders: z.record(address, positiveUint),
    }),
    oreVein: z.strictObject({
      owner: address,
      freeMine: address,
      pendingOwner: address,
      contractURI: z.string(),
      admins: z.array(address),
      successors: z.record(address, positiveUint),
    }),
    freeMine: z.strictObject({
      owner: address,
      magicOre: address,
      entryPrice: uint,
      priceUpdatedAt: uint,
      currentShiftId: positiveUint,
      dollar: z.strictObject({
        address,
        decimals: z.number().int().min(0).max(18),
      }),
      claims: z.record(z.string().regex(/^[1-9][0-9]*:[1-9][0-9]*$/), claim),
      shifts: z.record(uint, shift),
    }),
  })
  .superRefine((state, context) => {
    const issue = (message: string) =>
      context.addIssue({ code: 'custom', message })
    const balances = Object.values(state.magicOre.holders)
    if (
      balances.reduce((sum, amount) => sum + BigInt(amount), 0n) !==
      BigInt(state.magicOre.totalSupply)
    ) {
      issue('Holder balances do not sum to totalSupply')
    }
    if (zeroAddress in state.magicOre.holders) {
      issue('The zero address cannot hold MagicOre')
    }

    const admins = new Set(state.oreVein.admins)
    if (
      admins.size !== state.oreVein.admins.length ||
      admins.has(zeroAddress)
    ) {
      issue('Administrators must be unique, nonzero addresses')
    }
    if (admins.has(state.oreVein.owner)) {
      issue('The owner cannot also be an administrator')
    }
    for (const successor of Object.keys(state.oreVein.successors)) {
      if (
        admins.has(successor) ||
        (successor !== zeroAddress && successor === state.oreVein.owner)
      ) {
        issue('An active crew member cannot be a scheduled successor')
      }
    }

    const currentShiftId = BigInt(state.freeMine.currentShiftId)
    const requiredShifts = new Set([
      currentShiftId.toString(),
      (currentShiftId - 1n).toString(),
    ])
    const amounts = new Map<string, bigint>()
    for (const [key, claim] of Object.entries(state.freeMine.claims)) {
      if (key !== `${claim.shiftId}:${claim.claimId}`) {
        issue('Claim key does not match its identifiers')
      }
      if (claim.miner === zeroAddress) {
        issue('A claim must belong to a nonzero address')
      }
      requiredShifts.add(claim.shiftId)
      amounts.set(
        claim.shiftId,
        (amounts.get(claim.shiftId) ?? 0n) + BigInt(claim.oreAmount),
      )
      const shift = state.freeMine.shifts[claim.shiftId]
      if (
        !shift ||
        BigInt(claim.claimId) > BigInt(shift.currentClaimId) ||
        BigInt(claim.shiftId) > currentShiftId
      ) {
        issue('Claim references an absent or invalid shift')
      }
    }
    for (const id of requiredShifts) {
      if (!state.freeMine.shifts[id]) {
        issue('A required shift is missing')
      }
    }
    for (const [id, shift] of Object.entries(state.freeMine.shifts)) {
      if (!requiredShifts.has(id)) {
        issue('Historical shifts without active claims must not be retained')
      }
      if (BigInt(shift.oreAmount) !== (amounts.get(id) ?? 0n)) {
        issue('Shift amount does not equal the sum of its active claims')
      }
      if (!shift.funded) {
        if (
          shift.price !== '0' ||
          shift.dollar !== zeroAddress ||
          shift.fundedAt !== '0' ||
          shift.dollarScale !== '0'
        ) {
          issue('An unfunded shift cannot contain funding data')
        }
      } else if (shift.dollar === zeroAddress || shift.dollarScale === '0') {
        issue('A funded shift must identify its dollar token and scale')
      }
    }
    if (state.freeMine.shifts[state.freeMine.currentShiftId]?.funded) {
      issue('The current shift cannot be funded')
    }
  })
