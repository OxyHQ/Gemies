import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("artifact", Path(__file__).with_name("api-image-artifact.py"))
artifact = importlib.util.module_from_spec(spec)
spec.loader.exec_module(artifact)
SOURCE = "a" * 40
HEAD = "b" * 40


class ArtifactTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.environment = patch.dict(os.environ, {"GITHUB_REPOSITORY": "OxyHQ/Gemies", "GITHUB_RUN_ID": "123", "GITHUB_RUN_ATTEMPT": "1"})
        self.environment.start()
        self.addCleanup(self.environment.stop)

    def fixture(self, corrupt=False, mismatched=False):
        labels = {"org.opencontainers.image.source": "https://github.com/OxyHQ/Gemies", "org.opencontainers.image.revision": SOURCE}
        entries = {}
        def blob(value):
            payload = json.dumps(value).encode()
            digest = hashlib.sha256(payload).hexdigest()
            entries["blobs/sha256/" + digest] = payload
            return {"digest": "sha256:" + digest, "size": len(payload)}
        config = blob({"os": "linux", "architecture": "arm64", "config": {"Labels": labels}})
        manifest = blob({"schemaVersion": 2, "config": config, "layers": []})
        entries["index.json"] = json.dumps({"manifests": [manifest]}).encode()
        if corrupt:
            entries["blobs/sha256/" + manifest["digest"][7:]] = b"corrupt"
        with tarfile.open(self.root / "image.oci.tar", "w") as tar:
            for name, payload in entries.items():
                member = tarfile.TarInfo(name)
                member.size = len(payload)
                tar.addfile(member, io.BytesIO(payload))
        inspected = {"Os": "linux", "Architecture": "arm64", "Id": "sha256:" + "f" * 64 if mismatched else config["digest"], "Config": {"Labels": labels}}
        (self.root / "inspect.json").write_text(json.dumps([inspected]))
        return manifest["digest"]

    def test_archive_binds_smoked_configuration_and_reviewed_tree(self):
        manifest = self.fixture()
        with patch.object(artifact.subprocess, "check_output", return_value="c" * 40 + "\n"):
            result = artifact.record(self.root, SOURCE, HEAD)
        self.assertEqual(result["platformManifestDigest"], manifest)
        self.assertEqual(result["archiveSha256"], hashlib.sha256((self.root / "image.oci.tar").read_bytes()).hexdigest())
        self.assertEqual(result["sourceTree"], result["reviewedTree"])
        self.assertEqual(result["sourceCommit"], SOURCE)
        self.assertEqual(result["reviewedHead"], HEAD)

    def test_corrupted_manifest_rejected(self):
        self.fixture(corrupt=True)
        with self.assertRaisesRegex(ValueError, "digest/size"):
            artifact.record(self.root, SOURCE, HEAD)

    def test_different_smoke_image_rejected(self):
        self.fixture(mismatched=True)
        with self.assertRaisesRegex(ValueError, "smoke-tested"):
            artifact.record(self.root, SOURCE, HEAD)

    def test_merge_tree_drift_rejected(self):
        self.fixture()
        with patch.object(artifact.subprocess, "check_output", side_effect=["c" * 40, "d" * 40]):
            with self.assertRaisesRegex(ValueError, "rebase required"):
                artifact.record(self.root, SOURCE, HEAD)
        self.assertFalse((self.root / "provenance.json").exists())


if __name__ == "__main__":
    unittest.main()
