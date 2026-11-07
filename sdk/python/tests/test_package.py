"""Package metadata: ``__version__`` equals ``pyproject.toml``, the distribution is ``atmark-sdk`` (MIT) and ``py.typed`` ships."""

import re
import unittest

from _support import ROOT

import atmark

PYPROJECT = (ROOT / "pyproject.toml").read_text(encoding="utf-8")


def _field(name: str) -> str:
    match = re.search(r'^' + name + r'\s*=\s*"([^"]+)"', PYPROJECT, re.MULTILINE)
    assert match is not None, name
    return match.group(1)


class PackageTest(unittest.TestCase):
    def test_version_matches_metadata(self) -> None:
        self.assertEqual(atmark.__version__, _field("version"))
        self.assertEqual(atmark.SDK_VERSION, atmark.__version__)

    def test_distribution_name_license_and_typed_marker(self) -> None:
        self.assertEqual(_field("name"), "atmark-sdk")
        self.assertEqual(_field("license"), "MIT")
        self.assertIn('atmark = ["py.typed"]', PYPROJECT)
        self.assertTrue((ROOT / "src" / "atmark" / "py.typed").is_file())
        self.assertIn("MIT License", (ROOT / "LICENSE").read_text(encoding="utf-8"))

    def test_typescript_package_has_the_same_version(self) -> None:
        package_json = (ROOT.parent / "typescript" / "package.json").read_text(encoding="utf-8")
        self.assertIn('"version": "' + atmark.__version__ + '"', package_json)


if __name__ == "__main__":
    unittest.main()
