# dsh-superagent

dsh-superagent turns events from Sources into Tickets: it admits Triggers, holds conversations on Threads, and delivers work through replies and pull/merge requests. Core domain terms (Source, Trigger, Thread, Ticket, Admission, Channel, Delivery) are defined in [docs/001-domain.md](docs/001-domain.md). This glossary records the GitLab vocabulary introduced by the GitLab Source and how it maps onto the GitHub terms the codebase grew up with.

## Language

### GitLab Source

**Instance**:
The self-hosted GitLab server the GitLab Source talks to, identified by hostname. The GitLab Source targets self-hosted instances only, not gitlab.com.
_Avoid_: server, site.

**Project**:
GitLab's repository unit, addressed by its full path `namespace/project`; namespaces may nest (`group/subgroup/project`).
_Avoid_: repository (when talking about GitLab).

**Merge Request (MR)**:
GitLab's counterpart of a pull request.
_Avoid_: PR, pull request (when talking about GitLab).

**IID**:
A project-scoped number identifying an Issue or MR. Issues and MRs number independently, so an identity must carry both kind and IID (`group/project#12` vs `group/project!34`).
_Avoid_: number (GitHub's shared issue/PR sequence does not exist in GitLab).

**Note**:
A comment on an issue, merge request, or other GitLab object.
_Avoid_: comment (when talking about GitLab).

**Discussion**:
A threaded group of notes on a merge request, optionally resolvable. GitLab's counterpart of a GitHub review thread.
_Avoid_: review thread (when talking about GitLab).

**Pipeline**:
A GitLab CI run for a ref or commit. GitLab's counterpart of GitHub checks.
_Avoid_: checks (when talking about GitLab).

**Execution Project**:
The single Project whose repository workers clone, branch, and open merge requests in. Every deployment has exactly one.
_Avoid_: main repo, primary repo.

**Watch Project**:
A Project whose issues, merge requests, notes, and pipelines produce Triggers. A deployment watches one or more; the Execution Project is always among them.
_Avoid_: monitored repo.
