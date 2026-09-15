// The sidestr overlay for one chain document (SPEC 3, 4): a network beside its parent with
// signed blocks, no subsidy, trivial proof of work and its own address prefix. Data half: the
// network node and the signature rule joining btc:BlockRules. Code half: the check behind it.
import { blockData, solutionOf, virtualTxs } from './block.mjs';

export function sidestrGraph(chain) {
  return {
    '@id': 'sidestr:overlay', '@context': { sidestr: 'https://sidestr.com/ns#', knots: 'https://bitcoinknots.org/ns#' },
    '@graph': [
      {
        '@id': chain.id, '@type': 'btc:NetworkParams', extends: 'btc:regtest', label: chain.name, name: chain.name,
        comment: `sidestr chain beside ${chain.parent}: Bitcoin's rules with signed blocks (SPEC 4), no subsidy, every coin a peg.`,
        magic: chain.magic ?? 'e5d5e5d5', bech32Hrp: chain.addressPrefix, initialSubsidy: 0, halvingInterval: 210000,
        powLimit: chain.powLimit, powNoRetargeting: true, allowMinDifficultyBlocks: false,
        // BLAKE2b v2 headers from height 0, as the parent has them; no headline, no reduced-data period
        powHash: 'knots:blake2b-v2', structVariants: { 'btc:BlockHeader': [{ when: { field: 'version', bit: 31 }, struct: 'knots:BlockHeaderV2' }] },
        blake2bHeight: 0, blake2bHeadline: '', unifiedSighashParam: 'blake2bHeight', rdtsExpiryTime: 0,
        sidestrParent: chain.parent, sidestrChallenge: chain.challenge, sidestrPegConfirmations: chain.pegConfirmations ?? 6, sidestrRefundBlocks: chain.refundBlocks ?? 10000,
      },
      { '@id': 'sidestr:rule-block-signature', '@type': 'ValidationRule', ruleSet: 'btc:BlockRules', label: 'block-signature', errorCode: 'bad-block-signature',
        comment: 'The coinbase witness commitment output carries, after the commitment, a push of ecc7daa2 followed by a serialized witness that satisfies the chain challenge for the block data (SPEC 4).' },
    ],
  };
}

export const sidestrOverlay = (chain, { hash }) => ({
  graph: sidestrGraph(chain),
  installChecks({ blocks, interpreter, codec, params }) {
    blocks.registerChecks({ block: {
      'sidestr:rule-block-signature': ({ block }) => {
        if (!interpreter) return null;
        const sol = solutionOf(block);
        if (!sol) return false;
        const data = blockData({ codec, hash }, block);
        const { toSign, prevout } = virtualTxs({ codec }, data, params.sidestrChallenge, sol.witness);
        const v = interpreter.verifyInput(toSign, 0, prevout, [prevout], null);
        return v.ok === true;
      },
    } });
  },
});
