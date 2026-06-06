# Tool Risk Matrix

Risk is decided before model execution and again for each proposed tool call.

| Risk | Approval | Examples | Current Behavior |
| --- | --- | --- | --- |
| Read | Auto | Health checks, local memory read, safe metadata read | Execute automatically |
| Low | Notify | Calendar schedule read, Drive metadata list, Gmail draft create | Execute and show notification |
| Sensitive | Manual | Apple Messages read, finance summaries, Tesla status, Notes ingestion | Queue approval |
| High | Manual | Send message/email, delete files, Tesla command, money movement, browser login/payment | Queue approval or block |

## Initial Rules

- `send`, `text`, `message`, `delete`, `unlock`, `start`, `charge`, `transfer`, `buy`, `sell`, and `pay` are high risk.
- `Tesla`, `Chase`, `Robinhood`, banking, finance, iMessage, and Notes are sensitive unless a narrower tool policy says otherwise.
- Draft creation is low risk because it does not send.
- Browser automation is high risk by default.

## Approval Principles

- The user must see the tool name, operation, arguments summary, and dry-run description.
- The system must append an audit event when an approval is created or decided.
- Approval should expire quickly by default.
- Approved high-risk tools should be single-use; do not convert one approval into a broad permission grant.
