// @ts-check

/**
 * @file Shell-tool command allow/block lists and truncation suffixes.
 * @version 0.12.0
 *
 * @description
 * The three-tier shell gate: SAFE commands run with no approval, everything
 * else falls through to the HITL gate, and BLOCKED commands are refused even
 * with approval. Interpreters, mutators, and network tools are deliberately
 * not on the safe list.
 */




/**
 * Commands that run without any approval gate.
 * @type {readonly string[]}
 */
export const SHELL_TOOL_DEFAULT_SAFE_COMMANDS = Object.freeze([
    'ls', 'cat', 'head', 'tail', 'wc', 'echo', 'printf', 'pwd', 'whoami',
    'date', 'cal', 'which', 'type', 'uname', 'hostname',
    'uptime', 'id', 'groups', 'arch', 'sw_vers', 'ps', 'top',
    'df', 'du', 'file', 'stat', 'realpath', 'readlink', 'basename',
    'dirname', 'grep', 'egrep', 'fgrep', 'rg',
    'sort', 'uniq', 'cut', 'tr', 'diff', 'cmp', 'md5sum',
    'shasum', 'sha256sum', 'xxd', 'od', 'hexdump', 'strings',
    'mdls', 'mdfind', 'spotlight',
    'tput', 'locale', 'man', 'tldr'
]);


/**
 * Commands refused outright, even with operator approval.
 * @type {readonly string[]}
 */
export const SHELL_TOOL_DEFAULT_BLOCKED_COMMANDS = Object.freeze([
    'rm', 'rmdir', 'unlink', 'shred', 'truncate',
    'mv', 'cp', 'mkdir', 'touch', 'chmod', 'chown', 'chflags', 'chattr',
    'ln', 'mknod', 'mkfifo', 'mount', 'umount', 'diskutil',
    'sudo', 'su', 'doas', 'passwd', 'visudo',
    'kill', 'killall', 'pkill', 'pgrep',
    'dd', 'mkfs', 'mkfs.ext4', 'mkfs.apfs', 'fdisk', 'gdisk', 'parted',
    'shutdown', 'reboot', 'halt', 'poweroff', 'init',
    'crontab', 'at', 'batch', 'anacron', 'systemctl', 'service',
    'launchctl', 'sysctl',
    'curl', 'wget', 'nc', 'ncat', 'netcat', 'telnet', 'ssh', 'scp',
    'rsync', 'ftp', 'sftp', 'ftp', 'ping', 'traceroute', 'mtr',
    'useradd', 'userdel', 'usermod', 'groupadd', 'groupdel', 'groupmod',
    'adduser', 'deluser', 'addgroup', 'delgroup',
    'apt', 'apt-get', 'dpkg', 'rpm', 'yum', 'dnf', 'pacman', 'brew',
    'pip', 'pip3', 'npm', 'pnpm', 'yarn',
    'eval', 'exec', 'source', '.', 'bash', 'sh', 'zsh', 'fish', 'csh',
    'env', 'xargs'
]);


/**
 * Commands that only launch another command. The blocklist is unwrapped through
 * them, so `nice rm -rf /` is `rm`. Unwrapping is for the blocklist ONLY: a
 * wrapper never makes a command safer, and never demotes a safe-tier decision.
 *
 * Each entry names the wrapper's own options: `valueFlags` consume the next argv
 * entry, `valuePrefixFlags` also accept an attached value (`stdbuf -oL`),
 * `skipPositionals` counts operands that belong to the wrapper (timeout's
 * DURATION), `numericFlag` accepts `nice -5`, `anyFlag` accepts an option this
 * table cannot enumerate (`arch -x86_64`), and `noExecFlags` means the wrapper
 * only looks the command up instead of running it (`command -v rm`).
 * @type {Readonly<Record<string, {flags?: readonly string[], valueFlags?: readonly string[], valuePrefixFlags?: readonly string[], skipPositionals?: number, numericFlag?: boolean, anyFlag?: boolean, noExecFlags?: readonly string[]}>>}
 */
export const SHELL_TOOL_WRAPPER_COMMANDS = Object.freeze({
    nice: Object.freeze({ valueFlags: ['--adjustment'], valuePrefixFlags: ['-n'], numericFlag: true }),
    timeout: Object.freeze({
        flags: ['-v', '--verbose', '--foreground', '--preserve-status'],
        valueFlags: ['--signal', '--kill-after'],
        valuePrefixFlags: ['-s', '-k'],
        skipPositionals: 1
    }),
    time: Object.freeze({
        flags: ['-a', '--append', '-p', '--portability', '-v', '--verbose', '-q', '--quiet'],
        valueFlags: ['--format', '--output'],
        valuePrefixFlags: ['-f', '-o']
    }),
    command: Object.freeze({ flags: ['-p'], noExecFlags: ['-v', '-V'] }),
    nohup: Object.freeze({}),
    caffeinate: Object.freeze({
        flags: ['-d', '-i', '-m', '-s', '-u'],
        valuePrefixFlags: ['-t', '-w']
    }),
    stdbuf: Object.freeze({ valuePrefixFlags: ['-i', '-o', '-e'] }),
    arch: Object.freeze({ anyFlag: true }),
    // ── session / scheduler / resource launchers ────────────────────────────
    setsid: Object.freeze({ flags: ['-c', '--ctty', '-f', '--fork', '-w', '--wait'] }),
    // `flock [options] LOCKFILE command…`: the lock file is a positional.
    flock: Object.freeze({
        flags: ['-s', '--shared', '-x', '--exclusive', '-n', '--nb', '-o', '--close', '-F', '--no-fork', '-e', '--nonblock', '-v', '--verbose'],
        valueFlags: ['--timeout', '--conflict-exit-code'],
        valuePrefixFlags: ['-w', '-E'],
        skipPositionals: 1
    }),
    ionice: Object.freeze({
        flags: ['-t', '--ignore', '-g'],
        valueFlags: ['--class', '--classdata', '--pid', '--pgid', '--uid'],
        valuePrefixFlags: ['-c', '-n', '-p', '-P', '-u']
    }),
    // `taskset [options] MASK command…` (and its `-c LIST` form, whose value
    // lands in the skipped mask slot).
    taskset: Object.freeze({ anyFlag: true, skipPositionals: 1 }),
    // `chrt [options] PRIORITY command…`
    chrt: Object.freeze({ anyFlag: true, skipPositionals: 1 }),
    // `prlimit [options] command…`: every option is `-x`/`--long[=value]`.
    prlimit: Object.freeze({ anyFlag: true }),
    // `script [options] [file [command…]]` (BSD); the Linux `-c` form is blocked
    // as an expression, because a shell string hides the command inside it.
    script: Object.freeze({
        flags: ['-a', '-d', '-k', '-p', '-q', '-r', '-e', '-t', '-h'],
        valueFlags: ['--output', '--echo', '--log-timing', '--log-io'],
        valuePrefixFlags: ['-o', '-E', '-T', '-F'],
        skipPositionals: 1
    }),
    unbuffer: Object.freeze({ flags: ['-p'] })
});


/**
 * A `find` argument that runs or deletes — or a launcher argument that carries
 * the command as a shell string: the blocklist cannot see the command inside
 * either, so the expression itself is treated as blocked.
 * @type {Readonly<Record<string, readonly string[]>>}
 */
export const SHELL_TOOL_BLOCKED_COMMAND_ARGS = Object.freeze({
    find: Object.freeze(['-exec', '-execdir', '-delete', '-ok', '-okdir']),
    flock: Object.freeze(['-c']),
    script: Object.freeze(['-c'])
});


/**
 * Option allowlist for the SAFE tier. The tier is DEFAULT-DENY: a safe command
 * may carry only the options listed here. Anything unrecognised — a new flag, a
 * long alias of a write/exec flag, or a bundled cluster with an unlisted letter
 * — escalates to the HITL gate. This replaces the old dangerous-option denylist,
 * which could not be made sound: every enumerated hazard had an alias the list
 * did not name (e.g. `file --compile` for `file -C`).
 *
 *   flags              - options proven read-only (boolean or optional-value)
 *   valueFlags         - read-only options that consume the NEXT argv entry (or
 *                        an attached `=value` / cluster suffix) as their value
 *   fileFlags          - options whose operand is a filesystem path; the operand
 *                        is root-confined (a superset of valueFlags)
 *   literalPositionals - operands are text/patterns/names, not paths, so skip the
 *                        path-confinement check
 *   numericShorthand   - a bare `-<digits>` count is accepted (head/tail)
 *
 * A command absent from this map accepts no options at all (default-deny).
 *
 * @type {Readonly<Record<string, {flags?: readonly string[], valueFlags?: readonly string[], fileFlags?: readonly string[], literalPositionals?: boolean, numericShorthand?: boolean}>>}
 */
export const SHELL_TOOL_SAFE_OPTIONS = Object.freeze({
    // ── directory / file inspection ─────────────────────────────────────────
    ls: Object.freeze({
        flags: ['-a', '-A', '-b', '-c', '-C', '-d', '-e', '-f', '-F', '-g', '-G', '-h', '-H', '-i', '-k', '-l', '-m', '-n', '-o', '-p', '-q', '-Q', '-r', '-R', '-s', '-S', '-t', '-u', '-U', '-v', '-x', '-X', '-1', '-@', '-%', '-I', '-T', '-w',
            '--all', '--almost-all', '--escape', '--classify', '--directory', '--file-type', '--group', '--no-group', '--human-readable', '--inode', '--numeric-uid-gid', '--long', '--reverse', '--recursive', '--size', '--color', '--group-directories-first', '--author', '--context'],
        valueFlags: ['--ignore', '--hide', '--sort', '--time', '--format', '--indicator-style', '--quoting-style', '--time-style', '--block-size', '--tabsize', '--width'],
    }),    cat: Object.freeze({ flags: ['-A', '-b', '-e', '-E', '-n', '-s', '-t', '-T', '-u', '-v', '--show-all', '--number', '--number-nonblank', '--squeeze-blank', '--show-ends', '--show-tabs', '--show-nonprinting'] }),
    head: Object.freeze({ flags: ['-q', '-v', '-z', '--quiet', '--silent', '--verbose'], valueFlags: ['-c', '-n', '--bytes', '--lines'], numericShorthand: true }),
    tail: Object.freeze({ flags: ['-f', '-F', '-q', '-v', '-z', '-r', '--follow', '--quiet', '--silent', '--verbose', '--retry'], valueFlags: ['-c', '-n', '-s', '--bytes', '--lines', '--sleep-interval', '--pid'], numericShorthand: true }),
    stat: Object.freeze({ flags: ['-f', '-F', '-L', '-l', '-r', '-s', '-t', '-x', '--file-system', '--dereference', '--terse'], valueFlags: ['-c', '--format', '--printf'] }),
    file: Object.freeze({
        flags: ['-b', '-c', '-h', '-i', '-k', '-L', '-s', '-z', '--brief', '--checking-printout', '--no-dereference', '--mime', '--mime-type', '--mime-encoding', '--apple', '--exclude-quiet', '--no-sandbox', '--preserve-date', '--uncompress', '--raw', '--extension', '--symlink', '--dereference', '--no-buffer', '--keep-going', '--list', '--print0'],
        fileFlags: ['-m', '--magic-file'],
    }),
    realpath: Object.freeze({ flags: ['-e', '-m', '-L', '-P', '-q', '-s', '-z', '--canonicalize-existing', '--canonicalize-missing', '--logical', '--physical', '--quiet', '--silent', '--zero', '--no-symlinks'], valueFlags: ['--relative-to'] }),
    readlink: Object.freeze({ flags: ['-e', '-f', '-m', '-n', '-q', '-s', '-v', '-z', '-L', '-P', '--canonicalize', '--canonicalize-existing', '--canonicalize-missing', '--no-newline', '--quiet', '--silent', '--verbose', '--zero'] }),
    basename: Object.freeze({ flags: ['-a', '-z', '--multiple', '--zero'], valueFlags: ['-s', '--suffix'], literalPositionals: true }),
    dirname: Object.freeze({ flags: ['-z', '--zero'], literalPositionals: true }),

    // ── text search ─────────────────────────────────────────────────────────
    grep: Object.freeze({
        flags: ['-a', '-b', '-c', '-E', '-F', '-G', '-h', '-H', '-i', '-I', '-l', '-L', '-n', '-o', '-P', '-q', '-s', '-v', '-w', '-x', '-z', '-Z', '-U', '--text', '--byte-offset', '--count', '--extended-regexp', '--fixed-strings', '--basic-regexp', '--perl-regexp', '--with-filename', '--no-filename', '--ignore-case', '--files-with-matches', '--files-without-match', '--line-number', '--only-matching', '--quiet', '--silent', '--no-messages', '--invert-match', '--word-regexp', '--line-regexp', '--null-data', '--null', '--binary', '--line-buffered', '--color', '--initial-tab'],
        valueFlags: ['-A', '-B', '-C', '-D', '-e', '-m', '--after-context', '--before-context', '--context', '--devices', '--regexp', '--max-count', '--exclude', '--exclude-dir', '--binary-files', '--label'],
        fileFlags: ['-f', '--file', '--include'],
    }),
    egrep: Object.freeze({
        flags: ['-a', '-b', '-c', '-h', '-H', '-i', '-I', '-l', '-L', '-n', '-o', '-q', '-s', '-v', '-w', '-x', '-z', '-Z', '-U', '--text', '--byte-offset', '--count', '--with-filename', '--no-filename', '--ignore-case', '--files-with-matches', '--files-without-match', '--line-number', '--only-matching', '--quiet', '--silent', '--no-messages', '--invert-match', '--word-regexp', '--line-regexp', '--null-data', '--null', '--line-buffered', '--color', '--initial-tab'],
        valueFlags: ['-A', '-B', '-C', '-D', '-e', '-m', '--after-context', '--before-context', '--context', '--devices', '--regexp', '--max-count', '--exclude', '--exclude-dir', '--binary-files', '--label'],
        fileFlags: ['-f', '--file', '--include'],
    }),
    fgrep: Object.freeze({
        flags: ['-a', '-b', '-c', '-h', '-H', '-i', '-I', '-l', '-L', '-n', '-o', '-q', '-s', '-v', '-w', '-x', '-z', '-Z', '-U', '--text', '--byte-offset', '--count', '--with-filename', '--no-filename', '--ignore-case', '--files-with-matches', '--files-without-match', '--line-number', '--only-matching', '--quiet', '--silent', '--no-messages', '--invert-match', '--word-regexp', '--line-regexp', '--null-data', '--null', '--line-buffered', '--color', '--initial-tab'],
        valueFlags: ['-A', '-B', '-C', '-D', '-e', '-m', '--after-context', '--before-context', '--context', '--devices', '--regexp', '--max-count', '--exclude', '--exclude-dir', '--binary-files', '--label'],
        fileFlags: ['-f', '--file', '--include'],
    }),
    rg: Object.freeze({
        flags: ['-a', '-b', '-c', '-F', '-h', '-H', '-i', '-I', '-l', '-n', '-N', '-o', '-p', '-P', '-q', '-s', '-S', '-U', '-v', '-w', '-x', '-0', '--text', '--byte-offset', '--count', '--count-matches', '--files', '--files-with-matches', '--files-without-match', '--fixed-strings', '--glob-case-insensitive', '--heading', '--ignore-case', '--invert-match', '--json', '--line-number', '--line-regexp', '--multiline', '--multiline-dotall', '--no-heading', '--no-messages', '--no-unicode', '--null', '--null-data', '--only-matching', '--passthru', '--quiet', '--smart-case', '--stats', '--stop-on-nonmatch', '--unicode', '--vimgrep', '--with-filename', '--word-regexp', '--color'],
        valueFlags: ['-A', '-B', '-C', '-e', '-E', '-j', '-m', '-r', '-t', '-T', '--after-context', '--before-context', '--context', '--dfa-size-limit', '--encoding', '--engine', '--field-context-separator', '--field-match-separator', '--max-columns', '--max-count', '--max-depth', '--max-filesize', '--path-separator', '--regex-size-limit', '--replace', '--sort', '--sortr', '--threads', '--type', '--type-not', '--type-add', '--colors', '--context-separator', '--crlf'],
        fileFlags: ['-f', '-g', '--file', '--ignore-file'],
    }),

    // ── text processing ────────────────────────────────────────────────────
    sort: Object.freeze({
        flags: ['-b', '-c', '-C', '-d', '-f', '-g', '-h', '-i', '-m', '-M', '-n', '-R', '-r', '-s', '-u', '-V', '-z', '--ignore-leading-blanks', '--check', '--dictionary-order', '--ignore-case', '--general-numeric-sort', '--human-numeric-sort', '--ignore-nonprinting', '--merge', '--month-sort', '--numeric-sort', '--random-sort', '--reverse', '--stable', '--unique', '--version-sort', '--zero-terminated', '--debug'],
        valueFlags: ['-k', '-S', '-t', '--key', '--buffer-size', '--field-separator', '--parallel', '--batch-size', '--sort'],
        fileFlags: ['-T', '--temporary-directory'],
    }),
    uniq: Object.freeze({ flags: ['-c', '-d', '-D', '-u', '-i', '-z', '--count', '--repeated', '--all-repeated', '--unique', '--ignore-case', '--zero-terminated'], valueFlags: ['-f', '-s', '-w', '--skip-fields', '--skip-chars', '--check-chars'] }),
    cut: Object.freeze({ flags: ['-n', '-s', '-z', '--complement', '--only-delimited', '--zero-terminated'], valueFlags: ['-b', '-c', '-d', '-f', '--bytes', '--characters', '--delimiter', '--fields', '--output-delimiter'] }),
    tr: Object.freeze({ flags: ['-c', '-C', '-d', '-s', '-t', '--complement', '--delete', '--squeeze-repeats', '--truncate-set1'], literalPositionals: true }),
    diff: Object.freeze({
        flags: ['-a', '-b', '-B', '-c', '-d', '-e', '-E', '-f', '-i', '-n', '-N', '-p', '-q', '-s', '-t', '-T', '-u', '-w', '-y', '-Z', '--text', '--ignore-space-change', '--ignore-blank-lines', '--minimal', '--ignore-case', '--brief', '--report-identical-files', '--expand-tabs', '--initial-tab', '--suppress-blank-empty', '--ignore-all-space', '--side-by-side', '--ignore-trailing-space', '--normal', '--new-file', '--unidirectional-new-file', '--ignore-file-name-case', '--no-ignore-file-name-case', '--strip-trailing-cr', '--speed-large-files', '--color', '--ed', '--forward-ed', '--rcs', '--show-c-function'],
        valueFlags: ['-C', '-D', '-F', '-I', '-L', '-U', '-W', '-x', '--context', '--unified', '--width', '--tabsize', '--label', '--horizon-lines', '--palette', '--exclude', '--ignore-matching-lines'],
        fileFlags: ['-S', '-X', '--starting-file', '--from-file', '--to-file', '--exclude-from'],
    }),
    cmp: Object.freeze({ flags: ['-b', '-l', '-s', '-v', '--print-bytes', '--verbose', '--silent', '--quiet'], valueFlags: ['-i', '-n', '--ignore-initial', '--bytes'] }),

    // ── checksums / binary dump ────────────────────────────────────────────
    md5sum: Object.freeze({ flags: ['-b', '-t', '-w', '-z', '--binary', '--text', '--warn', '--status', '--strict', '--quiet', '--zero', '--ignore-missing', '--tag'] }),
    sha256sum: Object.freeze({ flags: ['-b', '-t', '-w', '-z', '--binary', '--text', '--warn', '--status', '--strict', '--quiet', '--zero', '--ignore-missing', '--tag'] }),
    shasum: Object.freeze({ flags: ['-b', '-p', '-s', '-0', '-1', '-2', '-3', '-4', '-5', '-6', '--binary', '--portable', '--status', '--zero', '--ignore-missing', '--warn', '--tag'], valueFlags: ['-a', '--algorithm'] }),
    xxd: Object.freeze({ flags: ['-a', '-b', '-d', '-e', '-i', '-p', '-u'], valueFlags: ['-c', '-g', '-l', '-o', '-s'] }),
    od: Object.freeze({ flags: ['-a', '-b', '-B', '-c', '-d', '-D', '-f', '-F', '-h', '-i', '-I', '-l', '-o', '-s', '-S', '-t', '-T', '-v', '-w', '-x', '--output-duplicates', '--strings'], valueFlags: ['-A', '-j', '-N', '--address-radix', '--skip-bytes', '--read-bytes', '--format', '--width', '--endian'] }),
    hexdump: Object.freeze({ flags: ['-b', '-c', '-C', '-d', '-o', '-v', '-x'], valueFlags: ['-e', '-n', '-s', '--format', '--length', '--skip'], fileFlags: ['-f', '--format-file'] }),
    strings: Object.freeze({ flags: ['-a', '-f', '-o', '-w', '--all', '--print-file-name', '--include-all-whitespace'], valueFlags: ['-n', '-t', '--bytes', '--radix'] }),

    // ── disk usage ─────────────────────────────────────────────────────────
    du: Object.freeze({ flags: ['-a', '-b', '-c', '-g', '-h', '-H', '-k', '-m', '-P', '-s', '-x', '-0', '--apparent-size', '--human-readable', '--summarize', '--total', '--count-links', '--no-dereference', '--one-file-system', '--null', '--time'], valueFlags: ['-B', '-d', '-t', '--block-size', '--max-depth', '--threshold', '--exclude', '--time-style'], fileFlags: ['--exclude-from'] }),
    wc: Object.freeze({ flags: ['-c', '-l', '-w', '-m', '-L', '--bytes', '--lines', '--words', '--chars', '--max-line-length'] }),
    df: Object.freeze({ flags: ['-a', '-g', '-h', '-H', '-i', '-k', '-l', '-m', '-P', '-T', '--all', '--human-readable', '--inodes', '--local', '--portable', '--print-type', '--sync', '--no-sync', '--output'], valueFlags: ['-t', '-x', '-B', '--type', '--exclude-type', '--block-size'] }),

    // ── environment / system ───────────────────────────────────────────────
    date: Object.freeze({ flags: ['-u', '-R', '-j', '--utc', '--rfc-2822', '--rfc-3339', '--debug'], valueFlags: ['-d', '--date'], fileFlags: ['-f', '-r', '--file', '--reference'] }),
    cal: Object.freeze({ flags: ['-h', '-j', '-m', '-w', '-y', '-3', '-1', '--one', '--three', '--year', '--julian', '--monday', '--week'], literalPositionals: true }),
    uname: Object.freeze({ flags: ['-a', '-i', '-m', '-n', '-o', '-p', '-r', '-s', '-v', '--all', '--hardware-platform', '--kernel-name', '--kernel-release', '--kernel-version', '--machine', '--nodename', '--operating-system', '--processor'] }),
    hostname: Object.freeze({ flags: ['-f', '-s', '-d', '--fqdn', '--short', '--domain'] }),
    whoami: Object.freeze({}),
    pwd: Object.freeze({ flags: ['-L', '-P', '--logical', '--physical'] }),
    uptime: Object.freeze({ flags: ['-p', '-s', '--pretty', '--since'] }),
    id: Object.freeze({ flags: ['-a', '-A', '-c', '-f', '-g', '-G', '-n', '-p', '-P', '-r', '-u', '-Z', '--all', '--context', '--group', '--groups', '--name', '--real', '--user'], literalPositionals: true }),
    groups: Object.freeze({ literalPositionals: true }),
    arch: Object.freeze({}),
    sw_vers: Object.freeze({ flags: ['-productName', '-productVersion', '-buildVersion'] }),
    ps: Object.freeze({ flags: ['-A', '-a', '-c', '-f', '-g', '-H', '-j', '-l', '-m', '-M', '-n', '-N', '-r', '-R', '-S', '-T', '-u', '-U', '-v', '-w', '-x', '-X', '-Z', '--forest'], valueFlags: ['-o', '-O', '-p', '-t', '-G', '-C', '-q', '-s', '-L', '--format', '--pid', '--tty', '--user', '--Group', '--ppid'], literalPositionals: false }),
    top: Object.freeze({ flags: ['-a', '-b', '-c', '-e', '-F', '-h', '-i', '-O', '-P', '-q', '-R', '-S', '-v', '-x'], valueFlags: ['-d', '-l', '-n', '-o', '-p', '-s', '-t', '-U', '-u', '-w', '-stats'], literalPositionals: true }),
    tput: Object.freeze({ flags: ['-V', '-x', '--version'], valueFlags: ['-T', '-S'], literalPositionals: true }),
    locale: Object.freeze({ flags: ['-a', '-c', '-k', '-m', '-v', '--all-locales', '--category-name', '--keyword-list', '--charmaps'], literalPositionals: true }),
    man: Object.freeze({ flags: ['-a', '-d', '-D', '-f', '-h', '-i', '-k', '-K', '-r', '-t', '-u', '-V', '-w', '-W', '--all', '--debug', '--whatis', '--apropos', '--locate', '--prompt', '--no-subpages', '--no-hyphenation', '--no-justification', '--troff'], valueFlags: ['-m', '-s', '-S', '--systems', '--sections', '--locale', '--encoding', '--request'] }),
    tldr: Object.freeze({ flags: ['-h', '-v', '--list', '--render', '--markdown'], valueFlags: ['-p', '-l', '--platform', '--language'] }),
    mdls: Object.freeze({ flags: ['-name', '-raw', '-null'] }),
    mdfind: Object.freeze({ flags: ['-0', '-count', '-interpret', '-literal', '-live'], valueFlags: ['-name'], fileFlags: ['-onlyin'], literalPositionals: true }),
    spotlight: Object.freeze({ literalPositionals: true }),

    // ── benign text / lookup ───────────────────────────────────────────────
    echo: Object.freeze({ flags: ['-n', '-e', '-E'], literalPositionals: true }),
    printf: Object.freeze({ literalPositionals: true }),
    which: Object.freeze({ flags: ['-a', '-s', '--all', '--skip-alias', '--skip-functions', '--skip-dot', '--tty-only', '--show-dot', '--show-tilde'], literalPositionals: true }),
    type: Object.freeze({ flags: ['-a', '-t', '-p', '-P', '-f'], literalPositionals: true })
});


/**
 * Suffixes appended to truncated shell output.
 * @type {Object<string, string>}
 */
export const SHELL_TOOL_TRUNCATION_SUFFIXES = Object.freeze({
    OVERFLOW: '\n...[TRUNCATED TO PREVENT TOKEN OVERFLOW]',
    STANDARD: '\n...[TRUNCATED]'
});
