"""Host credential files follow the provider account binding, not a pinned default."""

import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from harness.mixdog_agent import (
    PROVIDER_CREDENTIAL_FILES,
    _collect_provider_files,
    _host_credentials_path,
    _host_provider_credentials_path,
)


class HostCredentialsPathTest(unittest.TestCase):
    def _data_dir(self, pool):
        raw = tempfile.TemporaryDirectory()
        self.addCleanup(raw.cleanup)
        data = Path(raw.name)
        if pool is not None:
            (data / "provider-accounts.json").write_text(json.dumps(pool), encoding="utf-8")
        return data

    def test_selected_account_resolves_to_its_own_file(self):
        account = "2b2f5aef-e221-48b5-ad10-cda6e69357b3"
        data = self._data_dir({
            "version": 1,
            "providers": {
                "anthropic-oauth": {"accounts": [{"id": account}], "selectedId": account, "auto": True},
                "openai-oauth": {"accounts": [{"id": "default"}], "selectedId": "default"},
            },
        })
        env = {"MIXDOG_DATA_DIR": str(data)}
        with patch.dict(os.environ, env, clear=False):
            os.environ.pop("ANTHROPIC_OAUTH_CREDENTIALS_PATH", None)
            self.assertEqual(
                _host_credentials_path(),
                data / "provider-accounts" / "anthropic-oauth" / f"{account}.json",
            )
            # The default account keeps the provider's root credential file.
            self.assertEqual(
                _host_provider_credentials_path("openai-oauth"),
                data / PROVIDER_CREDENTIAL_FILES["openai-oauth"],
            )

    def test_missing_or_unreadable_pool_falls_back_to_default_file(self):
        for pool in (None, "not json"):
            with self.subTest(pool=pool):
                data = self._data_dir(None)
                if pool is not None:
                    (data / "provider-accounts.json").write_text(pool, encoding="utf-8")
                with patch.dict(os.environ, {"MIXDOG_DATA_DIR": str(data)}, clear=False):
                    os.environ.pop("ANTHROPIC_OAUTH_CREDENTIALS_PATH", None)
                    self.assertEqual(
                        _host_credentials_path(),
                        data / PROVIDER_CREDENTIAL_FILES["anthropic-oauth"],
                    )

    def test_explicit_override_wins_over_binding(self):
        data = self._data_dir({
            "providers": {"anthropic-oauth": {"selectedId": "some-account"}},
        })
        override = data / "explicit.json"
        env = {"MIXDOG_DATA_DIR": str(data), "ANTHROPIC_OAUTH_CREDENTIALS_PATH": str(override)}
        with patch.dict(os.environ, env, clear=False):
            self.assertEqual(_host_credentials_path(), override)

    def test_collect_provider_files_reads_the_bound_account_for_every_oauth_provider(self):
        account = "2caf0e7c-ced3-428f-857a-aa7c5aaf6f4b"
        data = self._data_dir({
            "providers": {"openai-oauth": {"selectedId": account}},
        })
        bound = data / "provider-accounts" / "openai-oauth" / f"{account}.json"
        bound.parent.mkdir(parents=True)
        bound.write_text("{}", encoding="utf-8")
        # The pinned default file exists but is empty: the state that broke the run.
        (data / PROVIDER_CREDENTIAL_FILES["openai-oauth"]).write_text("{}\n", encoding="utf-8")
        with patch.dict(os.environ, {"MIXDOG_DATA_DIR": str(data)}, clear=False):
            files = _collect_provider_files({"openai-oauth"})
        self.assertEqual(files[PROVIDER_CREDENTIAL_FILES["openai-oauth"]], bound)


if __name__ == "__main__":
    unittest.main()