import { logger } from '..'
import { RegisterTallyInput } from '../_decorators/RegisterTallyInput.decorator'
import { Source } from '../_models/Source'
import { TallyInput } from './_Source'
import net from 'net'

const AwjDelimiter = '\u0004' // End-Of-Transmission delimiter for AWJ
const MaxInputCount = 32

const LivepremierDeviceNames: Record<string, string> = {
    'NLC_RSALPHA': 'Aquilon RS Alpha',
    'NLC_RS1':     'Aquilon RS1',
    'NLC_RS2':     'Aquilon RS2',
    'NLC_RS3':     'Aquilon RS3',
    'NLC_RS4':     'Aquilon RS4',
    'NLC_RS5':     'Aquilon RS5',
    'NLC_RS6':     'Aquilon RS6',
    'NLC_C':       'Aquilon C',
    'NLC_CPLUS':   'Aquilon C+',
    'NLC_CMAX':    'Aquilon Cmax',
}

@RegisterTallyInput(
    'a21ae72c',
    'Analog Way Livepremier',
    'Standard port is 10606. Source addresses are the input number.',
    [
        { fieldName: 'ip', fieldLabel: 'IP Address', fieldType: 'text' },
        { fieldName: 'port', fieldLabel: 'Port', fieldType: 'port' },
    ],
)

export class AWLivepremierSource extends TallyInput {
    private client: net.Socket
    private port: number
    private buffer: string = ''
    private awTallyData: any = {}

    constructor(source: Source) {
        super(source)
        this.port = source.data.port

        this.client = new net.Socket()
        this.client.setEncoding('utf8')

        this.client.on('connect', () => {

            // Subscribe and get device type
            this.sendAwjRequest(
                { op: 'get', path: 'DeviceObject/system/$device/@items/1/@props/dev' },
                { op: 'replace', path: 'Subscriptions', value: [ 'DeviceObject/$input' ] }
            )

            let stateCommands = []
            for (let i = 0; i < MaxInputCount; i++) {
                stateCommands.push({ op: 'get', path: `DeviceObject/$input/@items/IN_${i + 1}/status/@props/isOnProgram` })
                stateCommands.push({ op: 'get', path: `DeviceObject/$input/@items/IN_${i + 1}/status/@props/isOnPreview` })
            }

            // Query initial input states
            this.sendAwjRequest(...stateCommands)

            this.connected.next(true)
        })

        this.client.on('data', (chunk: Buffer|string) => {
            //logger(`Source: ${source.name}  AW Livepremier data received: ${chunk}`, 'info-quiet');
            this.buffer += chunk.toString()

            let eotIndex;
            while ((eotIndex = this.buffer.indexOf(AwjDelimiter)) !== -1) {
                const message = this.buffer.substring(0, eotIndex);
                this.buffer = this.buffer.substring(eotIndex + 1);
                this.processMessage(source, message);
            }
        })

        this.client.on('close', () => {
            this.connected.next(false)
        })

        this.client.on('error', (error) => {
            logger(`Source: ${source.name}  AW Livepremier Connection Error occurred: ${error}`, 'error')
        })

        this.connect()
    }

    private sendAwjRequest(...commands: any[]) {
        let request = ''
        for (const cmd of commands) {
            request += JSON.stringify(cmd) + AwjDelimiter
        }

        this.client.write(request)
    }

    private processMessage(source: Source, rawJSON: string) {
        try {
            logger(`Source: ${source.name}  processing: ${rawJSON}`, 'info-quiet');
            const data = JSON.parse(rawJSON);

            if (data.error) {
                logger(`Source: ${source.name} ${data.error.message} (code: ${data.error.code})`, 'error');
                return;
            }
            
            else if (data.path === 'DeviceObject/system/$device/@items/1/@props/dev' && data.value) {
                const deviceName = LivepremierDeviceNames[data.value] || 'Unknown Device'
                logger('AW device type: ' + data.value + ' (' + deviceName + ')', 'info-quiet')
            }
            
            else if (data.path.startsWith('DeviceObject/$input/@items/') && data.value !== undefined) {
                const inputMatch = /^DeviceObject\/\$input\/@items\/IN_(\d+)\//.exec(data.path)
                if (inputMatch && inputMatch[1]) {
                    const inputId = inputMatch[1]

                    const tallyObj = this.awTallyData[inputId] || { program: false, preview: false }
                    if (this.awTallyData[inputId] === undefined) {
                        this.awTallyData[inputId] = tallyObj
                    }

                    if (/\/status\/@props\/isOnProgram$/.test(data.path)) {
                        const newValue = data.value === true
                        if (tallyObj.program !== newValue) {
                            tallyObj.program = newValue

                            if (newValue) {
                                this.addBusToAddress(inputId, 'program')
                            } else {
                                this.removeBusFromAddress(inputId, 'program')
                            }
                        }
                    } else if (/\/status\/@props\/isOnPreview$/.test(data.path)) {
                        const newValue = data.value === true
                        if (tallyObj.preview !== newValue) {
                            tallyObj.preview = newValue

                            if (newValue) {
                                this.addBusToAddress(inputId, 'preview')
                            } else {
                                this.removeBusFromAddress(inputId, 'preview')
                            }
                        }
                    }

                    this.sendTallyData()
                }

                // logger(`Source: ${source.name} ${JSON.stringify(this.awTallyData)}`, 'info-quiet')
            }
        } catch (e) {
            logger(`Source: ${source.name} Error parsing AWJ JSON: ${e}`, 'error');
        }
    }

    private connect(): void {
        this.client.connect(this.port, this.source.data.ip)
    }

    public reconnect(): void {
        this.connect()
    }

    public exit(): void {
        super.exit()
        this.client.end()
        this.client.destroy()
        this.connected.next(false)
    }
}
