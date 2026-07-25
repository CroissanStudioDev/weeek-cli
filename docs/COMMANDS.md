# Command reference

Everything below is generated from the bundled OpenAPI document by `bun run docs:commands`.
Do not edit inside the markers — the next codegen run will overwrite it.

Conventions that apply to every command:

- Path parameters are **positional**: `weeek task get <id>`.
- Query parameters and request-body fields are **flags**: `--project-id 4`, `--title "Ship it"`.
- Array and object body fields take JSON: `--locations '[{"lat":1,"lng":2}]'`.
- `--body '<json>'` is merged over the flags for anything the flattened flags cannot express.
- `--dry-run` prints the request that would be sent; `--json` / `--output table|yaml` pick the format.

Beyond the generated commands there are `weeek auth`, `weeek doctor`, `weeek schema`,
`weeek completion`, `weeek ui`, and the escape hatch `weeek api <METHOD> <PATH>`.

<!-- BEGIN GENERATED COMMANDS -->

153 commands across 12 namespaces, generated from `spec/weeek-openapi.json` — every operation the API documents has exactly one command (asserted by `tests/parity.test.ts`).

### `attachment` — attachment operations

| Command | Endpoint | What it does |
| --- | --- | --- |
| `weeek attachment download <file-id>` | `GET /ws/attachments/{file_id}` | Get an attachment _(binary)_ |

### `board` — board operations

| Command | Endpoint | What it does |
| --- | --- | --- |
| `weeek board create` | `POST /tm/boards` | Create board |
| `weeek board custom-field create <board-id>` | `POST /tm/boards/{board_id}/custom-fields` | Create a custom field |
| `weeek board custom-field delete <board-id> <id>` | `DELETE /tm/boards/{board_id}/custom-fields/{id}` | Delete a custom field |
| `weeek board custom-field option create <board-id> <custom-field-id>` | `POST /tm/boards/{board_id}/custom-fields/{custom_field_id}/options` | Create a custom field option |
| `weeek board custom-field option move <board-id> <custom-field-id> <id>` | `POST /tm/boards/{board_id}/custom-fields/{custom_field_id}/options/{id}/move` | Move a custom field option |
| `weeek board custom-field option update <board-id> <custom-field-id> <id>` | `PUT /tm/boards/{board_id}/custom-fields/{custom_field_id}/options/{id}` | Update a custom field option |
| `weeek board custom-field transfer-to-board <board-id> <id>` | `POST /tm/boards/{board_id}/custom-fields/{id}/transfer-to-board` | Transfer custom field to board |
| `weeek board custom-field transfer-to-project <board-id> <id>` | `POST /tm/boards/{board_id}/custom-fields/{id}/transfer-to-project` | Transfer custom field to project |
| `weeek board custom-field transfer-to-task-manager <board-id> <id>` | `POST /tm/boards/{board_id}/custom-fields/{id}/transfer-to-task-manager` | Transfer custom field to task manager |
| `weeek board custom-field update <board-id> <id>` | `PUT /tm/boards/{board_id}/custom-fields/{id}` | Update a custom field |
| `weeek board delete <id>` | `DELETE /tm/boards/{id}` | Delete board |
| `weeek board list` | `GET /tm/boards` | Get board list |
| `weeek board move <id>` | `POST /tm/boards/{id}/move` | Move board |
| `weeek board update <id>` | `PUT /tm/boards/{id}` | Update board |

### `board-column` — board-column operations

| Command | Endpoint | What it does |
| --- | --- | --- |
| `weeek board-column create` | `POST /tm/board-columns` | Create board column |
| `weeek board-column delete <id>` | `DELETE /tm/board-columns/{id}` | Delete board column |
| `weeek board-column list` | `GET /tm/board-columns` | Get board column list |
| `weeek board-column move <id>` | `POST /tm/board-columns/{id}/move` | Move board column |
| `weeek board-column update <id>` | `PUT /tm/board-columns/{id}` | Update board column |

### `crm` — CRM (deals, contacts, organizations, funnels)

| Command | Endpoint | What it does |
| --- | --- | --- |
| `weeek crm contact create` | `POST /crm/contacts` | Create a contact |
| `weeek crm contact delete <id>` | `DELETE /crm/contacts/{id}` | Delete a contact |
| `weeek crm contact email create <contact-id>` | `POST /crm/contacts/{contactId}/emails` | Create an email |
| `weeek crm contact email delete <contact-id> <email-id>` | `DELETE /crm/contacts/{contactId}/emails/{emailId}` | Delete the email |
| `weeek crm contact email update <contact-id> <email-id>` | `PUT /crm/contacts/{contactId}/emails/{emailId}` | Update the email |
| `weeek crm contact get <id>` | `GET /crm/contacts/{id}` | Get a contact |
| `weeek crm contact list` | `GET /crm/contacts` | Get all contacts |
| `weeek crm contact phone create <contact-id>` | `POST /crm/contacts/{contactsId}/phones` | Create a phone |
| `weeek crm contact phone delete <contact-id> <phone-id>` | `DELETE /crm/contacts/{contactsId}/phones/{phoneId}` | Delete the phone |
| `weeek crm contact phone update <contact-id> <phone-id>` | `PUT /crm/contacts/{contactsId}/phones/{phoneId}` | Update the phone |
| `weeek crm contact tag add <contact-id>` | `POST /crm/contacts/{contactId}/tags` | Attach a tag |
| `weeek crm contact tag remove <contact-id>` | `DELETE /crm/contacts/{contactId}/tags` | Detach the tag |
| `weeek crm contact update <id>` | `PUT /crm/contacts/{id}` | Update a contact |
| `weeek crm currency list` | `GET /crm/currencies` | Get all currencies |
| `weeek crm deal assignee add <deal-id>` | `POST /crm/deals/{dealId}/assignees` | Attach an assignee |
| `weeek crm deal assignee remove <deal-id>` | `DELETE /crm/deals/{dealId}/assignees` | Detach an assignee |
| `weeek crm deal attachment upload <deal-id>` | `POST /crm/deals/{deal_id}/attachments` | Upload attachments _(`--file`)_ |
| `weeek crm deal contact add <deal-id>` | `POST /crm/deals/{dealId}/contacts` | Attach a contact |
| `weeek crm deal contact remove <deal-id>` | `DELETE /crm/deals/{dealId}/contacts` | Detach a contact |
| `weeek crm deal delete <id>` | `DELETE /crm/deals/{id}` | Delete a deal |
| `weeek crm deal get <id>` | `GET /crm/deals/{id}` | Get a deal |
| `weeek crm deal move <id>` | `POST /crm/deals/{id}/move` | Move a deal |
| `weeek crm deal organization add <deal-id>` | `POST /crm/deals/{dealId}/organizations` | Attach an organization |
| `weeek crm deal organization remove <deal-id>` | `DELETE /crm/deals/{dealId}/organizations` | Detach an organization |
| `weeek crm deal patch <id>` | `PATCH /crm/deals/{id}` | Update a deal fields |
| `weeek crm deal set-funnel <id>` | `PUT /crm/deals/{id}/funnel` | Update the deal funnel |
| `weeek crm deal set-status <id>` | `PUT /crm/deals/{id}/status` | Update the deal funnel status |
| `weeek crm deal tag add <deal-id>` | `POST /crm/deals/{dealId}/tags` | Attach a tag |
| `weeek crm deal tag remove <deal-id>` | `DELETE /crm/deals/{dealId}/tags` | Detach a tag |
| `weeek crm deal task create <id>` | `POST /crm/deals/{id}/tasks` | Attach a new task |
| `weeek crm deal task delete <id> <task-id>` | `DELETE /crm/deals/{id}/tasks/{taskId}` | Detach a task |
| `weeek crm deal task move <id> <task-id>` | `POST /crm/deals/{id}/tasks/{taskId}/move` | Move a attached to the deal task |
| `weeek crm deal update <id>` | `PUT /crm/deals/{id}` | Update a deal |
| `weeek crm funnel create` | `POST /crm/funnels` | Create a funnel |
| `weeek crm funnel custom-field create <funnel-id>` | `POST /crm/funnels/{funnel_id}/custom-fields` | Create a custom field |
| `weeek crm funnel custom-field delete <funnel-id> <id>` | `DELETE /crm/funnels/{funnel_id}/custom-fields/{id}` | Delete a custom field |
| `weeek crm funnel custom-field move <funnel-id> <id>` | `POST /crm/funnels/{funnel_id}/custom-fields/{id}/move` | Move a custom field |
| `weeek crm funnel custom-field option create <funnel-id> <custom-field-id>` | `POST /crm/funnels/{funnel_id}/custom-fields/{custom_field_id}/options` | Create a custom field option |
| `weeek crm funnel custom-field option delete <funnel-id> <custom-field-id> <id>` | `DELETE /crm/funnels/{funnel_id}/custom-fields/{custom_field_id}/options/{id}` | Delete a custom field option |
| `weeek crm funnel custom-field option move <funnel-id> <custom-field-id> <id>` | `POST /crm/funnels/{funnel_id}/custom-fields/{custom_field_id}/options/{id}/move` | Move a custom field option |
| `weeek crm funnel custom-field option update <funnel-id> <custom-field-id> <id>` | `PUT /crm/funnels/{funnel_id}/custom-fields/{custom_field_id}/options/{id}` | Update a custom field option |
| `weeek crm funnel custom-field update <funnel-id> <id>` | `PUT /crm/funnels/{funnel_id}/custom-fields/{id}` | Update a custom field |
| `weeek crm funnel delete <id>` | `DELETE /crm/funnels/{id}` | Delete a funnel |
| `weeek crm funnel get <id>` | `GET /crm/funnels/{id}` | Get a funnel |
| `weeek crm funnel list` | `GET /crm/funnels` | Get all funnels |
| `weeek crm funnel status create <funnel-id>` | `POST /crm/funnels/{funnelId}/statuses` | Create a funnel status |
| `weeek crm funnel status list <funnel-id>` | `GET /crm/funnels/{funnelId}/statuses` | Get all funnel statuses |
| `weeek crm funnel update <id>` | `PUT /crm/funnels/{id}` | Update a funnel |
| `weeek crm organization address create <organization-id>` | `POST /crm/organizations/{organizationId}/addresses` | Create an address |
| `weeek crm organization address delete <organization-id> <address-id>` | `DELETE /crm/organizations/{organizationId}/addresses/{addressId}` | Delete the address |
| `weeek crm organization address update <organization-id> <address-id>` | `PUT /crm/organizations/{organizationId}/addresses/{addressId}` | Update the address |
| `weeek crm organization contact add <organization-id>` | `POST /crm/organizations/{organizationId}/contacts` | Attach a contact |
| `weeek crm organization contact remove <organization-id>` | `DELETE /crm/organizations/{organizationId}/contacts` | Detach the contact |
| `weeek crm organization create` | `POST /crm/organizations` | Create an organization |
| `weeek crm organization delete <id>` | `DELETE /crm/organizations/{id}` | Delete an organization |
| `weeek crm organization email create <organization-id>` | `POST /crm/organizations/{organizationId}/emails` | Create an email |
| `weeek crm organization email delete <organization-id> <email-id>` | `DELETE /crm/organizations/{organizationId}/emails/{emailId}` | Delete the email |
| `weeek crm organization email update <organization-id> <email-id>` | `PUT /crm/organizations/{organizationId}/emails/{emailId}` | Update the email |
| `weeek crm organization get <id>` | `GET /crm/organizations/{id}` | Get an organization |
| `weeek crm organization list` | `GET /crm/organizations` | Get all organizations |
| `weeek crm organization phone create <organization-id>` | `POST /crm/organizations/{organizationId}/phones` | Create a phone |
| `weeek crm organization phone delete <organization-id> <phone-id>` | `DELETE /crm/organizations/{organizationId}/phones/{phoneId}` | Delete the phone |
| `weeek crm organization phone update <organization-id> <phone-id>` | `PUT /crm/organizations/{organizationId}/phones/{phoneId}` | Update the phone |
| `weeek crm organization tag add <organization-id>` | `POST /crm/organizations/{organizationId}/tags` | Attach a tag |
| `weeek crm organization tag remove <organization-id>` | `DELETE /crm/organizations/{organizationId}/tags` | Detach the tag |
| `weeek crm organization update <id>` | `PUT /crm/organizations/{id}` | Update an organization |
| `weeek crm status deal create <status-id>` | `POST /crm/statuses/{statusId}/deals` | Create a deal |
| `weeek crm status deal list <status-id>` | `GET /crm/statuses/{statusId}/deals` | Get all deals |
| `weeek crm status delete <id>` | `DELETE /crm/statuses/{id}` | Delete a funnel status |
| `weeek crm status get <id>` | `GET /crm/statuses/{id}` | Get a funnel status |
| `weeek crm status update <id>` | `PUT /crm/statuses/{id}` | Update a funnel status |

### `custom-field` — custom-field operations

| Command | Endpoint | What it does |
| --- | --- | --- |
| `weeek custom-field create` | `POST /tm/custom-fields` | Create global custom field |
| `weeek custom-field delete <id>` | `DELETE /tm/custom-fields/{id}` | Delete global custom field |
| `weeek custom-field list` | `GET /tm/custom-fields` | Get global custom fields |
| `weeek custom-field option create <custom-field-id>` | `POST /tm/custom-fields/{custom_field_id}/options` | Create global custom field option |
| `weeek custom-field option delete <custom-field-id> <id>` | `DELETE /tm/custom-fields/{custom_field_id}/options/{id}` | Delete global custom field option |
| `weeek custom-field option move <custom-field-id> <id>` | `POST /tm/custom-fields/{custom_field_id}/options/{id}/move` | Move global custom field option |
| `weeek custom-field option update <custom-field-id> <id>` | `PUT /tm/custom-fields/{custom_field_id}/options/{id}` | Update global custom field option |
| `weeek custom-field transfer-to-board <id>` | `POST /tm/custom-fields/{id}/transfer-to-board` | Transfer global custom field to board |
| `weeek custom-field transfer-to-project <id>` | `POST /tm/custom-fields/{id}/transfer-to-project` | Transfer global custom field to project |
| `weeek custom-field update <id>` | `PUT /tm/custom-fields/{id}` | Update global custom field |

### `me` — Current user

| Command | Endpoint | What it does |
| --- | --- | --- |
| `weeek me` | `GET /user/me` | Get profile |

### `member` — member operations

| Command | Endpoint | What it does |
| --- | --- | --- |
| `weeek member list` | `GET /ws/members` | Get workspace members |

### `portfolio` — portfolio operations

| Command | Endpoint | What it does |
| --- | --- | --- |
| `weeek portfolio create` | `POST /tm/portfolios` | Create portfolio |
| `weeek portfolio delete <id>` | `DELETE /tm/portfolios/{id}` | Delete portfolio |
| `weeek portfolio get <id>` | `GET /tm/portfolios/{id}` | Get portfolio |
| `weeek portfolio list` | `GET /tm/portfolios` | Get portfolios |
| `weeek portfolio update <id>` | `PUT /tm/portfolios/{id}` | Update portfolio |

### `project` — project operations

| Command | Endpoint | What it does |
| --- | --- | --- |
| `weeek project archive <id>` | `POST /tm/projects/{id}/archive` | Archive project |
| `weeek project create` | `POST /tm/projects` | Create project |
| `weeek project custom-field create <project-id>` | `POST /tm/projects/{project_id}/custom-fields` | Create a custom field |
| `weeek project custom-field delete <project-id> <id>` | `DELETE /tm/projects/{project_id}/custom-fields/{id}` | Delete a custom field |
| `weeek project custom-field option create <project-id> <custom-field-id>` | `POST /tm/projects/{project_id}/custom-fields/{custom_field_id}/options` | Create a custom field option |
| `weeek project custom-field option delete <project-id> <custom-field-id> <id>` | `DELETE /tm/projects/{project_id}/custom-fields/{custom_field_id}/options/{id}` | Delete a custom field option |
| `weeek project custom-field option move <project-id> <custom-field-id> <id>` | `POST /tm/projects/{project_id}/custom-fields/{custom_field_id}/options/{id}/move` | Move a custom field option |
| `weeek project custom-field option update <project-id> <custom-field-id> <id>` | `PUT /tm/projects/{project_id}/custom-fields/{custom_field_id}/options/{id}` | Update a custom field option |
| `weeek project custom-field transfer-to-board <project-id> <id>` | `POST /tm/projects/{project_id}/custom-fields/{id}/transfer-to-board` | Transfer custom field to board |
| `weeek project custom-field transfer-to-project <project-id> <id>` | `POST /tm/projects/{project_id}/custom-fields/{id}/transfer-to-project` | Transfer custom field to project |
| `weeek project custom-field transfer-to-task-manager <project-id> <id>` | `POST /tm/projects/{project_id}/custom-fields/{id}/transfer-to-task-manager` | Transfer custom field to task manager |
| `weeek project custom-field update <project-id> <id>` | `PUT /tm/projects/{project_id}/custom-fields/{id}` | Update a custom field |
| `weeek project delete <id>` | `DELETE /tm/projects/{id}` | Delete project |
| `weeek project get <id>` | `GET /tm/projects/{id}` | Get project |
| `weeek project list` | `GET /tm/projects` | Get project list |
| `weeek project un-archive <id>` | `POST /tm/projects/{id}/un-archive` | Un Archive project |
| `weeek project update <id>` | `PUT /tm/projects/{id}` | Update project info |

### `tag` — tag operations

| Command | Endpoint | What it does |
| --- | --- | --- |
| `weeek tag create` | `POST /ws/tags` | Create tag |
| `weeek tag delete <id>` | `DELETE /ws/tags/{id}` | Delete tag |
| `weeek tag get <id>` | `GET /ws/tags/{id}` | Tag |
| `weeek tag list` | `GET /ws/tags` | Tag list |
| `weeek tag update <id>` | `PUT /ws/tags/{id}` | Update tag |

### `task` — task operations

| Command | Endpoint | What it does |
| --- | --- | --- |
| `weeek task assignee add <task-id>` | `POST /tm/tasks/{taskId}/assignees` | Add assignees |
| `weeek task assignee remove <task-id>` | `DELETE /tm/tasks/{taskId}/assignees` | Remove assignee |
| `weeek task attachment upload <task-id>` | `POST /tm/tasks/{task_id}/attachments` | Upload attachments _(`--file`)_ |
| `weeek task complete <id>` | `POST /tm/tasks/{id}/complete` | Complete task |
| `weeek task create` | `POST /tm/tasks` | Create task |
| `weeek task delete <id>` | `DELETE /tm/tasks/{id}` | Delete task |
| `weeek task get <id>` | `GET /tm/tasks/{id}` | Get one task info |
| `weeek task list` | `GET /tm/tasks` | Get tasks _(`--all-pages`)_ |
| `weeek task location add <task-id>` | `POST /tm/tasks/{task_id}/locations` | Add a task to a project |
| `weeek task location remove <task-id>` | `DELETE /tm/tasks/{task_id}/locations` | Remove a task from a project |
| `weeek task set-board <id>` | `POST /tm/tasks/{id}/board` | Change board |
| `weeek task set-column <id>` | `POST /tm/tasks/{id}/board-column` | Change board column |
| `weeek task set-parent <task-id>` | `POST /tm/tasks/{taskId}/parent` | Change task parent |
| `weeek task start-timer <id>` | `POST /tm/tasks/{id}/start-timer` | Start task timer |
| `weeek task stop-timer <id>` | `POST /tm/tasks/{id}/stop-timer` | Stop task timer |
| `weeek task time-entry create <task-id>` | `POST /tm/tasks/{task_id}/time-entries` | Create a time entry |
| `weeek task time-entry delete <task-id> <time-entry-id>` | `DELETE /tm/tasks/{task_id}/time-entries/{time_entry_id}` | Delete a time entry |
| `weeek task time-entry update <task-id> <time-entry-id>` | `PUT /tm/tasks/{task_id}/time-entries/{time_entry_id}` | Update a time entry |
| `weeek task un-complete <id>` | `POST /tm/tasks/{id}/un-complete` | Un complete task |
| `weeek task update <id>` | `PUT /tm/tasks/{id}` | Update a task |
| `weeek task watcher add <task-id>` | `POST /tm/tasks/{task_id}/watchers` | Add watchers to a task |
| `weeek task watcher remove <task-id>` | `DELETE /tm/tasks/{task_id}/watchers` | Remove watchers from a task |

### `workspace` — workspace operations

| Command | Endpoint | What it does |
| --- | --- | --- |
| `weeek workspace info` | `GET /ws` | Get workspace info |

<!-- END GENERATED COMMANDS -->
