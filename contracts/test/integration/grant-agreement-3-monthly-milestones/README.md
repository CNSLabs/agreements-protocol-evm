# Grant Agreement - 3 Monthly Milestones - Integration Tests

This directory contains integration tests for the Grant Agreement - 3 Monthly Milestones agreement, a 3-month KPI-based grant agreement with milestone-driven payments and signature gating.

## Agreement Overview

The Grant Agreement - 3 Monthly Milestones agreement models a grant process with:
- **Signature gating** before Month 1 (grantee signs, then grantor signs)
- **3 monthly KPI cycles** (Month 1, Month 2, Month 3)
- **Review and approval workflow** for each month
- **Rejection and resubmission capability** within each month
- **Termination option** available at any stage for the grantor

### State Machine Flow

```
PENDING_GRANTEE_SIGNATURE
  ↓ (grantee signs)
PENDING_GRANTOR_SIGNATURE
  ↓ (grantor signs)
MONTH_1_KPI_SUBMISSION
  ↓ (grantee submits work)
MONTH_1_KPI_REVIEW
  ↓ (grantor approves)         ↺ (grantor rejects - back to submission)
MONTH_2_KPI_SUBMISSION
  ↓ (grantee submits work)
MONTH_2_KPI_REVIEW
  ↓ (grantor approves)         ↺ (grantor rejects - back to submission)
MONTH_3_KPI_SUBMISSION
  ↓ (grantee submits work)
MONTH_3_KPI_REVIEW
  ↓ (grantor approves)         ↺ (grantor rejects - back to submission)
COMPLETE

  [AGREEMENT_TERMINATED can be reached from any submission or review state]
```

## Test Coverage

The test suite (`grant-agreement-3-monthly-milestones.test.ts`) includes:

### 1. Happy Path
- **Complete 3-month flow**: Tests the full agreement lifecycle from Month 1 through Month 3 with all approvals, reaching the COMPLETE state

### 2. Rejection and Resubmission Flows
- **Month 1 rejection**: Grantor rejects Month 1 submission, grantee resubmits
- **Month 2 rejection**: Grantor rejects Month 2 submission, grantee resubmits  
- **Month 3 rejection**: Grantor rejects Month 3 submission, grantee resubmits

### 3. Termination Paths
- **Month 1 submission termination**: Grantor terminates during Month 1 submission phase
- **Month 1 review termination**: Grantor terminates during Month 1 review phase
- **Month 2 submission termination**: Grantor terminates during Month 2 submission phase
- **Month 3 review termination**: Grantor terminates during Month 3 review phase

### 4. Signer Validation Enforcement
- **Grantee signature validation**: Rejects grantee signature from grantor address
- **Grantor signature validation**: Rejects grantor signature from grantee address
- **Month 1 work submission validation**: Rejects submission from grantor (should be grantee)
- **Month 1 approval validation**: Rejects approval from grantee (should be grantor)
- **Month 2 rejection validation**: Rejects rejection from grantee (should be grantor)
- **Termination validation**: Rejects termination from grantee (should be grantor)

### 5. Multiple Rejection Cycles
- **Repeated rejection/resubmission**: Tests multiple rejection and resubmission cycles within Month 1

## Sample Inputs

Sample input files are located in `/agreements/grant-agreement-3-monthly-milestones/unwrapped/`:

- `input-grantee-signature.json` - Grantee signature
- `input-grantor-signature.json` - Grantor signature
- `input-m1-work-submission.json` - Month 1 work submission by grantee
- `input-m1-approve.json` - Month 1 approval by grantor
- `input-m1-reject.json` - Month 1 rejection by grantor
- `input-m1-terminate.json` - Month 1 termination by grantor
- `input-m2-work-submission.json` - Month 2 work submission by grantee
- `input-m2-approve.json` - Month 2 approval by grantor
- `input-m2-reject.json` - Month 2 rejection by grantor
- `input-m2-terminate.json` - Month 2 termination by grantor
- `input-m3-work-submission.json` - Month 3 work submission by grantee
- `input-m3-approve.json` - Month 3 approval by grantor
- `input-m3-reject.json` - Month 3 rejection by grantor
- `input-m3-terminate.json` - Month 3 termination by grantor

## Running the Tests

```bash
# Run all tests for this agreement
npx hardhat test test/integration/grant-agreement-3-monthly-milestones/grant-agreement-3-monthly-milestones.test.ts

# Run specific test suites
npx hardhat test test/integration/grant-agreement-3-monthly-milestones/grant-agreement-3-monthly-milestones.test.ts --grep "Happy Path"
npx hardhat test test/integration/grant-agreement-3-monthly-milestones/grant-agreement-3-monthly-milestones.test.ts --grep "Signer Validation"
```

## Key Learnings

This test suite demonstrates:

1. **Multi-stage DFSM execution** - How to model complex multi-month workflows with conditional branching
2. **Rejection loops** - How to implement resubmission workflows within the DFSM model
3. **Early termination** - How to allow graceful exit from any state in the state machine
4. **Issuer validation** - How the protocol enforces that only authorized addresses can submit specific inputs
5. **Comprehensive test patterns** - Testing happy paths, error cases, edge cases, and security validations

## Agreement Structure

The agreement JSON follows the Agreements Protocol standard with:
- **Metadata**: Agreement identification and versioning
- **Variables**: Dynamic values (grantor/grantee addresses)
- **Content**: Markdown-formatted legal agreement text
- **Execution**: DFSM-based state machine with inputs and transitions
