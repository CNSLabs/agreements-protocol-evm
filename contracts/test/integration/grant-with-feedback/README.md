# Grant-with-feedback integration tests

This folder contains payment-flow integration tests built on top of the same work-based agreement flow:

1. Sign agreement
2. Submit work
3. Review and accept/reject
4. Pay recipient

## Active payment demos

- `grant-with-feedback.test.ts`: baseline FSM behavior.
- `grant-with-feedback-permit.test.ts`: permit-based submissions.
- `grant-with-feedback-onchain-action.test.ts`: atomic payment using an agreement action that calls `ERC20.transferFrom`.

## Agreement variants used

- `agreements/grant-with-feedback/unwrapped/grant-with-feedback.json`
- `agreements/grant-with-feedback-auto-pay-actions/unwrapped/grant-with-feedback-auto-pay-actions.json`

## Quick run

From `contracts/`:

```bash
npm run test
```

Run only grant-with-feedback tests:

```bash
npm run test -- --grep "grant-with-feedback"
```

