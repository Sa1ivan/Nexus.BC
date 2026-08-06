const major = Number.parseInt(process.versions.node.split('.')[0] ?? '', 10);

if (major !== 24) {
  process.stderr.write(
    `Nexus verification requires Node.js 24; received ${process.versions.node}.\n`,
  );
  process.exitCode = 1;
}
