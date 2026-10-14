import { builtinModules } from "node:module";

// Prefix-only modules such as "node:test" are left out so a real npm package named "test" isn't mistaken for one.
const NODE_BUILTINS = new Set(builtinModules.filter((m) => !m.startsWith("node:")).map((m) => m.split("/")[0]!));

export function isNodeBuiltin(specifier: string): boolean {
  return specifier.startsWith("node:") || NODE_BUILTINS.has(specifier.split("/")[0]!);
}

const PYTHON_STDLIB = new Set(
  (
    "__future__ abc argparse array ast asyncio atexit base64 bdb binascii bisect builtins bz2 calendar cmath cmd code " +
    "codecs collections colorsys concurrent configparser contextlib contextvars copy copyreg csv ctypes curses " +
    "dataclasses datetime dbm decimal difflib dis doctest email encodings ensurepip enum errno faulthandler fcntl " +
    "filecmp fileinput fnmatch fractions ftplib functools gc getopt getpass gettext glob graphlib grp gzip hashlib " +
    "heapq hmac html http imaplib importlib inspect io ipaddress itertools json keyword linecache locale logging " +
    "lzma mailbox marshal math mimetypes mmap multiprocessing netrc numbers operator optparse os pathlib pdb pickle " +
    "pkgutil platform plistlib poplib posix pprint profile pstats pty pwd py_compile pyclbr pydoc queue quopri " +
    "random re readline reprlib resource rlcompleter runpy sched secrets select selectors shelve shlex shutil signal " +
    "site smtplib socket socketserver sqlite3 ssl stat statistics string stringprep struct subprocess symtable sys " +
    "sysconfig syslog tabnanny tarfile tempfile termios textwrap threading time timeit tkinter token tokenize " +
    "tomllib trace traceback tracemalloc tty turtle types typing unicodedata unittest urllib uuid venv warnings wave " +
    "weakref webbrowser wsgiref xml xmlrpc zipapp zipfile zipimport zlib zoneinfo"
  ).split(" "),
);

export function isPythonStdlib(topLevel: string): boolean {
  return PYTHON_STDLIB.has(topLevel);
}
