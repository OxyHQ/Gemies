#!/usr/bin/env python3
"""Bind an OCI archive to the exact image that passed the API smoke test."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tarfile


def record(directory, source, reviewed_head):
    if not all(re.fullmatch(r"[a-f0-9]{40}", value) for value in (source, reviewed_head)):
        raise ValueError("Invalid source revision")
    root = Path(directory)
    inspected, = json.loads((root / "inspect.json").read_text())
    if (inspected["Os"], inspected["Architecture"]) != ("linux", "arm64"):
        raise ValueError("Unexpected image platform")
    labels = inspected["Config"]["Labels"]
    repository = os.environ["GITHUB_REPOSITORY"]
    if labels.get("org.opencontainers.image.revision") != source or labels.get(
        "org.opencontainers.image.source"
    ) != f"https://github.com/{repository}":
        raise ValueError("Image source labels do not match checkout")
    archive = root / "image.oci.tar"
    with tarfile.open(archive) as contents:
        def blob(descriptor):
            digest = descriptor["digest"]
            if not re.fullmatch(r"sha256:[a-f0-9]{64}", digest):
                raise ValueError("Unsupported OCI digest")
            member = contents.getmember("blobs/sha256/" + digest[7:])
            if not member.isfile():
                raise ValueError("OCI blob is not a file")
            payload = contents.extractfile(member).read()
            if len(payload) != descriptor["size"] or hashlib.sha256(payload).hexdigest() != digest[7:]:
                raise ValueError("OCI blob digest/size mismatch")
            return json.loads(payload)

        index = json.load(contents.extractfile("index.json"))
        candidates = []
        def visit(descriptor, depth=0):
            if depth > 3:
                raise ValueError("Unexpected OCI nesting")
            item = blob(descriptor)
            if "manifests" in item:
                for child in item["manifests"]:
                    visit(child, depth + 1)
            elif item.get("config", {}).get("digest") == inspected["Id"]:
                config = blob(item["config"])
                if config.get("architecture") != "arm64" or config.get("os") != "linux":
                    raise ValueError("OCI configuration platform mismatch")
                candidates.append(descriptor["digest"])
        for descriptor in index["manifests"]:
            visit(descriptor)
        if len(candidates) != 1:
            raise ValueError("Archive does not contain exactly the smoke-tested image")
    def git_tree(revision):
        return subprocess.check_output(["git", "rev-parse", revision + "^{tree}"], text=True).strip()
    source_tree, head_tree = git_tree(source), git_tree(reviewed_head)
    if source_tree != head_tree:
        raise ValueError("Tested merge tree differs from reviewed PR head; rebase required")
    with archive.open("rb") as stream:
        checksum = hashlib.file_digest(stream, "sha256").hexdigest()
    metadata = {
        "repository": repository, "sourceCommit": source, "reviewedHead": reviewed_head,
        "sourceTree": source_tree, "reviewedTree": head_tree,
        "runId": os.environ["GITHUB_RUN_ID"], "runAttempt": os.environ["GITHUB_RUN_ATTEMPT"],
        "platform": "linux/arm64", "imageConfigDigest": inspected["Id"],
        "platformManifestDigest": candidates[0], "archiveSha256": checksum,
        "smokePassed": True,
    }
    (root / "provenance.json").write_text(json.dumps(metadata, indent=2) + "\n")
    (root / "image.oci.tar.sha256").write_text(checksum + "  image.oci.tar\n")
    return metadata


if __name__ == "__main__":
    record(*sys.argv[1:])
