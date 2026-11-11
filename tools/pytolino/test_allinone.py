import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest

from allinone import supervise


class SupervisionTests(unittest.TestCase):
    def service(self, name, code):
        return name, [sys.executable, "-c", code], None, os.environ.copy()

    def test_child_exit_fails_container_and_stops_peer(self):
        with tempfile.TemporaryDirectory() as folder:
            pidfile = Path(folder) / "peer.pid"
            peer = self.service("peer", f"import os,time;open({str(pidfile)!r},'w').write(str(os.getpid()));time.sleep(60)")
            failed = self.service("failed", "import time;time.sleep(.2);raise SystemExit(7)")
            with self.assertRaisesRegex(RuntimeError, "failed exited unexpectedly"):
                supervise([peer, failed], lambda: None, interval=.02)
            pid = int(pidfile.read_text())
            with self.assertRaises(ProcessLookupError):
                os.kill(pid, 0)

    def test_failed_health_stops_services(self):
        def unhealthy():
            raise OSError("fixture not ready")
        with self.assertRaisesRegex(RuntimeError, "health checks failed"):
            supervise([self.service("peer", "import time;time.sleep(60)")],
                      unhealthy, startup_timeout=.05, interval=.02)

    def test_stop_event_shuts_down_cleanly(self):
        stop = threading.Event()
        supervise([self.service("peer", "import time;time.sleep(60)")],
                  stop.set, interval=.01, stop=stop)

    def test_repeated_health_failure_after_readiness_is_fatal(self):
        calls = 0
        def check():
            nonlocal calls
            calls += 1
            if calls > 1:
                raise OSError("fixture stopped responding")
        with self.assertRaisesRegex(RuntimeError, "health checks failed"):
            supervise([self.service("peer", "import time;time.sleep(60)")],
                      check, interval=.01)
        self.assertEqual(calls, 4)

    def test_sigterm_stops_process_group_descendants(self):
        with tempfile.TemporaryDirectory() as folder:
            pidfile = Path(folder) / "descendant.pid"
            child_code = f"import os,time;open({str(pidfile)!r},'w').write(str(os.getpid()));time.sleep(60)"
            parent_code = f"import subprocess,sys,time;subprocess.Popen([sys.executable,'-c',{child_code!r}]);time.sleep(60)"
            stop = threading.Event()
            def ready():
                if not pidfile.exists():
                    raise OSError("not ready")
                stop.set()
            supervise([self.service("parent", parent_code)], ready, interval=.02, stop=stop)
            pid = int(pidfile.read_text())
            result = subprocess.run(["ps", "-o", "stat=", "-p", str(pid)], capture_output=True, text=True)
            self.assertTrue(result.returncode != 0 or result.stdout.strip().startswith("Z"))


if __name__ == "__main__":
    unittest.main()
