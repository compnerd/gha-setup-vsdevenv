const core = require('@actions/core')
const process = require('process')
const path = require('path')
const spawn = require('child_process').spawnSync

function getInputs() {
    return {
        "host_arch": core.getInput('host_arch') || null,
        "arch": core.getInput('arch') || null,
        "toolset_version": core.getInput('toolset_version') || null,
        "winsdk": core.getInput('winsdk') || null,
        "vswhere": core.getInput('vswhere') || null,
        "components": core.getInput('components') || null,
        "verbose": Boolean(core.getInput('verbose'))
    }
}

function findVSWhere(inputs) {
    const vswhere = inputs.vswhere || 'vswhere.exe'
    const vsInstallerPath = path.win32.join(process.env['ProgramFiles(x86)'], 'Microsoft Visual Studio', 'Installer')
    const vswherePath = path.win32.resolve(vsInstallerPath, vswhere)
    console.log(`vswhere: ${vswherePath}`)
    return vswherePath
}

function findVSInstallDir(inputs, vswherePath) {
    const components = inputs.components.split(';').filter(s => s.length != 0)
    if (!inputs.toolsetVersion) {
        // Include the target architecture compiler toolset by default
        if (arch === 'arm64') {
            components.push('Microsoft.VisualStudio.Component.VC.Tools.ARM64')
        }
        else if (arch == 'arm') {
            components.push('Microsoft.VisualStudio.Component.VC.Tools.ARM')
        }
        else {
            components.push('Microsoft.VisualStudio.Component.VC.Tools.x86.x64')
        }
    }

    const requiresArg = components
        .map(comp => ['-requires', comp])
        .reduce((arr, pair) => arr.concat(pair), [])

    const vswhereArgs = [
        '-nologo',
        '-latest',
        '-products', '*',
        '-property', 'installationPath',
    ].concat(requiresArg)

    console.log(`$ ${vswherePath} ${vswhereArgs.join(' ')}`)

    const vswhereResult = spawn(vswherePath, vswhereArgs, {encoding: 'utf8'})
    if (vswhereResult.error) throw vswhereResult.error

    if (verbose) {
      const args = [
        '-nologo',
        '-latest',
        '-products', '*',
      ].concat(requiresArg)
      const details = spawn(vswherePath, args, { encoding: 'utf8' })
      console.log(details.output.join(''))
    }

    const installPathList = vswhereResult.output.filter(s => !!s).map(s => s.trim())
    if (installPathList.length == 0) throw new Error('Could not find compatible VS installation')

    const installPath = installPathList[installPathList.length - 1]
    console.log(`install: ${installPath}`)
    return installPath
}

function getVSDevCmdArgs(inputs) {
    // Default to the native processor as the host architecture
    // vsdevcmd accepts both amd64 and x64
    const hostArch = inputs.host_arch || process.env['PROCESSOR_ARCHITECTURE'].toLowerCase() // amd64, x86 or arm64

    // Default to the host architecture as the target architecture
    const arch = inputs.arch || hostArch

    const args = [
        `-host_arch=${hostArch}`,
        `-arch=${arch}`
    ]

    if (inputs.toolsetVersion)
        vsDevCmdArgs.push(`-vcvars_ver=${toolsetVersion}`)
    if (inputs.winsdk)
        args.push(`-winsdk=${winsdk}`)

    return args
}

try {
    // this job has nothing to do on non-Windows platforms
    if (process.platform != 'win32') {
        process.exit(0)
    }

    const inputs = getInputs()

    const installPath = findVSInstallDir(inputs, findVSWhere())
    core.setOutput('install_path', installPath)

    const vsDevCmdPath = path.win32.join(installPath, 'Common7', 'Tools', 'vsdevcmd.bat')
    console.log(`vsdevcmd: ${vsDevCmdPath}`)

    const vsDevCmdArgs = getVSDevCmdArgs(inputs)
    const cmdArgs = [].concat(['/q', '/k', vsDevCmdPath], vsDevCmdArgs, ['&&', 'set'])
    console.log(`$ cmd ${cmdArgs.join(' ')}`)

    const cmdResult = spawn('cmd', cmdArgs, {encoding: 'utf8'})
    if (cmdResult.error) throw cmdResult.error

    const cmdOutput = cmdResult.output
        .filter(s => !!s)
        .map(s => s.split('\n'))
        .reduce((arr, sub) => arr.concat(sub), [])
        .filter(s => !!s)
        .map(s => s.trim())

    const completeEnv = cmdOutput
        .filter(s => s.indexOf('=') != -1)
        .map(s => s.split('=', 2))
    const newEnvVars = completeEnv
        .filter(([key, _]) => !process.env[key])
    const newPath = completeEnv
                        .filter(([key, _]) => key == 'Path')
                        .map(([_, value]) => value)
                        .join(';');

    for (const [key, value] of newEnvVars) {
        core.exportVariable(key, value)
    }
    core.exportVariable('Path', newPath);

    console.log('environment updated')
} catch (error) {
    core.setFailed(error.message);
}
