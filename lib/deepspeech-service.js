const {Client, createLogger} = require('jaxcore');
const fork = require('child_process').fork;
const childProcessPath = __dirname + '/deepspeech-process.js';
const VAD = require('node-vad');
const {recordingStates, vadStates} = require('./constants');

const schema = {
	id: {
		type: 'string',
		defaultValue: 'speech'
	},
	connected: {
		type: 'boolean',
		defaultValue: false
	},
	modelName: {
		type: 'string'
	},
	modelPath: {
		type: 'string'
	},
	vadMode: {
		type: 'string',
		defaultValue: 'VERY_AGGRESSIVE'
	},
	silenceThreshold: {
		type: 'number',
		defaultValue: 200
	},
	recording: {
		type: 'boolean',
		defaultValue: false
	},
	debug: {
		type: 'boolean',
		defaultValue: false
	},
	debugProcess: {
		type: 'boolean',
		defaultValue: false
	},
	bufferSize: {
		type: 'number',
		defaultValue: 3
	}
};

let _instance = 0;

const speechInstances = {};

class DeepSpeechService extends Client {
	constructor(store, defaults) {
		super(schema, store, defaults);
		
		this.log = createLogger('SpeechService:' + (_instance++));
		this.log('create', defaults);
		
		this.serviceType = 'deepspeech';
		this.deviceType = 'deepspeech';
		
		speechInstances[this.id] = this;
		
		this.vad = new VAD(VAD.Mode[this.state.vadMode]);
		this.endTimeout = null;
		
		this.silenceStart = null;
		this.silenceBuffers = [];
		this.recordedChunks = 0;
		this.lastSilenceChunk = null;
	}
	
	streamData(deepspeechData, sampleRate, hotword, vadData) {
		if (hotword) {
			this.log('SET HOTWORD', hotword);
			this.setState({hotword});
		}
		
		let method = vadData? 'processAudioFloat' : 'processAudio';
		let data = vadData? vadData : deepspeechData;
		
		this.vad[method](data, sampleRate || 16000).then((res) => {
			switch (res) {
				case VAD.Event.ERROR:
					console.log("VAD ERROR", res);
					break;
				case VAD.Event.NOISE:
					console.log("VAD NOISE");
					break;
				case VAD.Event.SILENCE:
					// process.stdout.write('.');
					// return;
					this.processSilence(deepspeechData);
					
					break;
				case VAD.Event.VOICE:
					// process.stdout.write('=');
					// return;
					this.processVoice(deepspeechData);
					break;
			}
		}).catch(e => {
			this.log('err', e);
		})
		
		clearTimeout(this.endTimeout);
		this.endTimeout = setTimeout(() => {
			this.println('[timeout]');
			this.sendRecordingState(recordingStates.OFF);
			this.streamReset();
		}, 1000); // stream will time out after 1 second
	}
	
	streamEnd() {
		clearTimeout(this.endTimeout);
		this.sendRecordingState(recordingStates.OFF);
		this.recordedChunks = 0;
		this.silenceStart = null;
		this.proc.send('stream-end');
		if (this.lastSilenceChunk) {
			this.silenceBuffers = [this.lastSilenceChunk];
			this.lastSilenceChunk = null;
		}
	}
	
	disableHotword() {
		if (this.state.hotword) {
			this.log('hotword was', this.state.hotword);
			this.setState({hotword: null});
		}
	}
	
	streamReset() {
		clearTimeout(this.endTimeout);
		this.disableHotword();
		this.sendRecordingState(recordingStates.OFF);
		this.println('[reset]');
		this.recordedChunks = 0;
		this.silenceStart = null;
		try {
			this.proc.send('stream-reset');
		}
		catch(e) {
			this.log('DeepSpeech service reset error', e);
		}
	}
	
	_connected() {
		this.log('connected');
		this.setState({
			connected: true
		});
		this.emit('connect');
	}
	
	disconnect() {
		this.setState({
			connected: false
		});
		this.emit('connect');
	}
	
	connect() {
		this.log('connecting');
		
		let proc = fork(childProcessPath, [
			this.state.modelName,
			this.state.modelPath,
			this.state.debugProcess
		]);
		
		proc.on('exit', (code, sig) => {
			this.log('proc.on(\'exit\')', code);
			process.exit();
		});
		
		proc.on('error', (error) => {
			this.log('speech process error', error);
			process.exit();
		});
		
		proc.on('message', (data) => {
			if (typeof data !== 'object') {
				console.error('data', data);
				return;
			}
			
			if (data.ready === true) {
				this.log('process ready');
				this._connected();
			}
			else if ('noRecognition' in data) {
				this.emit('no-recognition', this.state.hotword);
				
				if (this.state.hotword) {
					this.log('noRecognition hotword was set', this.state.hotword);
					this.setState({
						hotword: null
					});
					this.log('noRecognition hotword now', this.state.hotword);
				}
			}
			else if ('recognize' in data) {
				this.processRecognition(data.recognize.text, data.recognize.stats);
			}
		});
		
		process.on('exit', () => {
			this.log("killing speech proc");
			proc.kill();
		});
		
		this.proc = proc;
	}
	
	processRecognition(text, stats) {
		if (this.state.hotword) {
			this.log('hotword was set', this.state.hotword);
			
			stats.hotword = this.state.hotword;
			
			this.emit('hotword', this.state.hotword, text, stats);
			this.setState({
				hotword: null
			});
			this.log('hotword now', this.state.hotword);
		}
		else {
			if (text === 'he') {  // bug in DeepSpeech 0.8 emits "he" a lot even during silence
				console.log('skip "HE"');
				return;
			}
			this.emit('recognize', text, stats);
		}
	}
	
	sendRecordingState(recordingState) {
		if (this.state.recording !== recordingState) {
			this.setState({recording: recordingState});
			this.emit('recording', recordingState);
			if (this.state.debug) {
				onRecording(recordingState);
			}
		}
	}
	
	sendVADState(vad) {
		if (this.state.vad !== vad) {
			this.setState({vad});
		}
		this.emit('vad', vad);
		if (this.state.debug) onVAD(vad);
	}
	
	processSilence(data) {
		
		if (this.recordedChunks > 0) { // recording is on
			
			this.sendVADState(vadStates.IDLE);
			this.proc.send(data);
			
			if (this.silenceStart === null) {
				this.silenceStart = new Date().getTime();
			}
			else {
				let now = new Date().getTime();
				if (now - this.silenceStart > this.state.silenceThreshold) {
					this.lastSilenceChunk = data;
					this.silenceStart = null;
					this.sendRecordingState(recordingStates.OFF);
					this.streamEnd();
				}
			}
		}
		else {
			
			this.sendVADState(vadStates.SILENCE);
			if (data) this.bufferSilence(data);
		}
	}
	
	processVoice(data) {
		this.silenceStart = null;
		
		if (this.recordedChunks === 0) {
			this.sendRecordingState(recordingStates.ON);
		}
		else {
			this.sendVADState(vadStates.VOICE);
		}
		this.recordedChunks++;
		data = this.addBufferedSilence(data);
		this.proc.send(data);
	}
	
	bufferSilence(data) {
		// VAD has a tendency to cut the first bit of audio data from the start of a recording
		// so keep a buffer of that first bit of audio and in addBufferedSilence() reattach it to the beginning of the recording
		this.silenceBuffers.push(data);
		while (this.silenceBuffers.length > this.state.bufferSize) {
			this.silenceBuffers.shift();
		}
	}
	
	addBufferedSilence(data) {
		let audioBuffer;
		if (this.silenceBuffers.length) {
			this.silenceBuffers.push(data);
			let length = 0;
			this.silenceBuffers.forEach(function (buf) {
				length += buf.length;
			});
			audioBuffer = Buffer.concat(this.silenceBuffers, length);
			this.silenceBuffers = [];
		}
		else audioBuffer = data;
		return audioBuffer;
	}
	
	println() {
		if (this.state.debug) this.log.apply(null, Array.from(arguments));
	}
	
	print() {
		if (this.state.debug) process.stdout.write(Array.from(arguments).join(','));
	}
	
	destroy() {
		this.proc.send('destroy');
		this.proc.removeAllListeners();
		this.proc.kill();
		this.disconnect();
	}
	
	static id(serviceConfig) {
		return 'deepspeech:' + serviceConfig.modelName;
	}
	
	static getOrCreateInstance(serviceStore, serviceId, serviceConfig, callback) {
		if (speechInstances[serviceId]) {
			let instance = speechInstances[serviceId];
			callback(null, instance);
		}
		else {
			let instance = new DeepSpeechService(serviceStore, {
				id: serviceId,
				modelName: serviceConfig.modelName,
				modelPath: serviceConfig.modelPath,
				silenceThreshold: serviceConfig.silenceThreshold,
				vadMode: serviceConfig.vadMode,
				debug: serviceConfig.debug,
				debugProcess: serviceConfig.debugProcess,
			});
			
			callback(null, instance, true);
		}
	}
	
	static getInstance(serviceId) {
		return speechInstances[serviceId];
	}
}

DeepSpeechService.recordingStates = recordingStates;
DeepSpeechService.vadStates = vadStates;

const onRecording = function (recordingState) {
	switch (recordingState) {
		case recordingStates.ON:
			process.stdout.write('\n');
			process.stdout.write('[start]');
			break;
		case recordingStates.OFF:
			process.stdout.write('[stop]');
			process.stdout.write('\n');
			break;
	}
};
const onVAD = function (vadState) {
	switch (vadState) {
		case vadStates.SILENCE:
			process.stdout.write('.');
			break;
		case vadStates.VOICE:
			process.stdout.write('=');
			break;
		case vadStates.IDLE:
			process.stdout.write('-');
			break;
	}
};

module.exports = DeepSpeechService;