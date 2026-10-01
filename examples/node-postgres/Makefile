# Notes example. `make update-demo` shows the update mechanics on this machine
# (two local versions, a local registry, trust mode none); see README.md.
.PHONY: update-demo demo-down config-check

update-demo:
	../update-demo.sh . up

demo-down:
	../update-demo.sh . down

# Validate updater.yaml with the sidecar image (no Docker socket needed).
config-check:
	docker run --rm -v "$(CURDIR):/example:ro" -e CICD_UPDATER_COMPOSE__PROJECT_DIR=/example \
		ghcr.io/restow-backup/cicd-updater:1.0.0 config check --file /example/updater.yaml
