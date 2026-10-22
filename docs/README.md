# Bayes documentation

`docs/` is for human readers. These guides may explain context and walk through
steps in detail, including requirements also stated in agent guidance when useful.
Agent instructions live in `CODING_STANDARDS.md` at the repository root.

Start with the task you want to do:

| Task | Guide |
| --- | --- |
| Configure and run a public checkout | [Local development](development.md) |
| Understand runtime data flow | [Architecture](architecture.md) |
| Understand the testing direction | [Testing for refactoring](testing.md) |
| Call or change an endpoint | [API guide](api.md) |
| Operate or deploy your own installation | [Operations](operations.md) |
| Set up local data files | [Data templates](../templates/README.md) |
| Work on HTTP modules | [Route conventions](../src/routes/README.md) |
| Work on cached public reads | [Public read conventions](../src/publicRead/README.md) |
| Work on error logging | [Tail Worker](../oem-logger/README.md) |
| Work on image processing | [Transcoder](../containers/oem_imgTrans/README.md) |

## Maintaining these guides

Keep maintained guides directly under `docs/`. Put temporary reports, migration
plans, and measurement evidence in a subdirectory such as `docs/local/`.
The `/docs/*/` Git rule ignores direct subdirectories and their contents;
files directly under `docs/` are tracked normally. Review new documentation
for private configuration and data before committing.
