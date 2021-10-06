'use strict';

/*

  ==Comms.js - A simple webrtc wrapper that uses scaledrone==

  whenever variables refer to "local", it means this browser's data, and this browser's user
  whenever variables refer to "remote", it means the person that we're connecting to's data

*/

/* 

  ==Events==
  Each event function you register should expect to recieve two arguments:
    1.The Comm that the event has been called on
    2.Additional Event Data (Specific For Event) (Even if an event doesnt take additional data, it still needs to take the argument)

  remoteMicUpdate : Remote Mic Muted/Unmuted - {newMicStatus: boolean}
  remoteCamUpdate : Remote Camera Turned On/Off - {newCamStatus: boolean}
  cantJoin        : When the user isn't allowed to join (already 2 people OR they're already connected in another tab) - {reason: string}
  micError        : Can't Start Microphone - {error: string}
  camError        : Can't Start Camera - {error: string}
  chatMessage     : Someone Sent A Chat Message - {message: string, senderName: string}
  otherLeave      : The Other Person Left - {otherName: string}
  localMicActivityUpdate : The Local Mic Has Become Active/Inactive (Someone started/stopped talking) - {newMicActivity: boolean}
  remoteMicActivityUpdate : The Remote Mic Has Become Active/Inactive (Someone started/stopped talking) - {newMicActivity: boolean}

*/

//A constant for debugging various aspects of the system
//If this is on, any instances of a Comm will be exposed to the console via document.comm
const DEBUG = true;

//Default config to use for PeerConnections, can be overriden with the config argument in the constructor
const DEFAULT_CONFIG = {
    iceServers: [{
        urls: 'stun:stun.l.google.com:19302'
    }],
};

//If the activity level is below this value, don't send it
const DEFAULT_AUDIO_THRESHOLD = 13;

//The default video options to be passed to getUserMedia when turning on the webcam
const DEFAULT_VIDEO_OPTIONS = {
    facingMode: "user"
}

//The default video options to be passed to getUserMedia when turning on the microphone
const DEFAULT_AUDIO_OPTIONS = {
    noiseSuppression: true
}

//Used to store data and objects relating to our user
class LocalData {
    constructor(video, context) {
        Object.defineProperties(this, {
            'videoElement': {
                value: video
            },
            'micOn': {
                value: false,
                writable: true
            },
            'camOn': {
                value: false,
                writable: true
            },
            'micActivity': {
                value: false,
                writable: true
            },
            'noAudioNode': {
                value: context.createOscillator()
            },
            'audio': {
                value: null,
                writable: true,
                configurable: true
            },
            'audioAnalyser': {
                value: context.createAnalyser()
            },
            'micNode': {
                value: null,
                writable: true,
                configurable: true
            },
            'gainNode': {
                value: context.createGain()
            },
            'noiseGateNode': {
                value: null,
                writable: true,
                configurable: true
            },
            'delayNode': {
                value: context.createDelay()
            },
            'streamNode': {
                value: context.createMediaStreamDestination()
            },
            'novideoCanvas': {
                value: document.createElement("canvas")
            },
            'noCamImage': {
                value: new Image()
            },
            'video': {
                value: null,
                writable: true,
                configurable: true
            },
            'name': {
                value: "NULL",
                writable: true
            }
        });
        Object.defineProperty(this, 'novideoContext', {
            value: this.novideoCanvas.getContext("2d")
        });
    }
}

//Used to store data and objects relating to the other user
class RemoteData {
    constructor(id, name, peerConfig, localData, make_channel, noVideoStream) {

        // Create Elements For This Remote
        const new_video = document.createElement("video");
        const new_audio = document.createElement("audio");
        new_video.setAttribute('id', `${id}-video-element`);
        new_video.srcObject = noVideoStream;
        new_audio.setAttribute('id', `${id}-audio-element`);

        // Initialize A PeerConnection
        const pc = new RTCPeerConnection(peerConfig);

        // Initialize Audio & Visual Channels
        const audioSender = pc.addTrack(localData.streamNode.stream.getAudioTracks()[0]);
        const videoSender = pc.addTrack(localData.video.getVideoTracks()[0]);

        // Initialize Data Channel
        let dataChannel = null;
        if (make_channel) dataChannel = pc.createDataChannel(`Data channel for ${id} (Comms.js)`);

        Object.defineProperties(this, {
            'id': {
                value: id,
                writable: false
            },
            'videoElement': {
                value: new_video
            },
            'audioElement': {
                value: new_audio
            },
            'micOn': {
                value: false,
                writable: true
            },
            'camOn': {
                value: false,
                writable: true
            },
            'name': {
                value: name,
                writable: false
            },
            'pc': {
                value: pc,
                writable: false
            },
            'audioSender': {
                value: audioSender,
                writable: true
            },
            'videoSender': {
                value: videoSender,
                writable: true
            },
            'channel': {
                value: dataChannel,
                writable: true
            },
            'sdpDone': {
                value: false,
                writable: true
            },
        });
    }
}

/**
 * @class Comms
 * The main class of this library, use it to conect with webrtc
 * 1. Call the constructor, supplying the corrent args
 * 2. Initialize any event handlers or buttons
 * 3. Call init()
 * 4. Call join() (this actually connects to scaledrone and inits webrtc, so its recommended you call this after a button press)
 */
export default class Comms {

    /**
     * Use this to make a new Comm object, then call init() and join()
     *
     *@param {video} localVideo - The video element representing the user's camera
     * 
     *@param {URL} noVideoImage - A link to an image that will be displayed when the user's camera is off
     *
     *@param {object} events - A dictionary (string->function) that represents the events you'd like to interface with
     *
     *@param {RTCConfiguration} config (optional) - A RTCConfiguration object that tells the PeerConnection how to connect, will use google's STUN servers by default
     */
    constructor(localVideo, noVideoImage, events, config = DEFAULT_CONFIG) {

        this.signalTypes = {};
        this.messageTypes = {};
        this.remotes = {};

        this.audioContext = new AudioContext();

        this.local = new LocalData(localVideo, this.audioContext);
        this.noVideoImageLink = noVideoImage;

        Object.defineProperties(this, {
            "peerConfig": {
                value: config,
                writable: false
            },
            "on": {
                value: events,
                writable: false
            }
        });

        if (DEBUG) document.comm = this;

    }

    /**
     * Begin capturing mic and camera, and initialize a peer connection
     * 
     *@param {MediaStreamConstraints} videoOptions - Options to be passed to getUserMedia when turning on webcam
     * 
     *@param {MediaStreamConstraints} audioOptions - Options to be passed to getUserMedia when turning on microphone
     * 
     *@param {number} audioThreshold - Anything below this value will not be sent through WebRTC (You can also set this later on with .setAudioThreshold())
     * 
     */
    init(videoOptions = DEFAULT_VIDEO_OPTIONS, audioOptions = DEFAULT_AUDIO_OPTIONS, audioThreshold = DEFAULT_AUDIO_THRESHOLD) {

        this.videoOptions = videoOptions;
        this.audioOptions = audioOptions;
        this.audioThreshold = audioThreshold;

        this.queued = [];
        this.registerSignalType("sdp", this.receiveSdp.bind(this));
        this.registerSignalType("candidate", this.candidateReceived.bind(this));

        //Begin Audio setup
        // this.registerMessageType("micStatus", this.remoteMicChanged);
        // this.registerMessageType("activityChanged", this.remoteActivityChange);

        this.local.audioAnalyser.smoothingTimeConstant = 0.5;
        this.local.gainNode.gain.value = 1;
        this.local.delayNode.delayTime.value = 0.05;
        this.local.micNode = this.local.noAudioNode;
        this.local.micNode.connect(this.local.audioAnalyser);
        this.local.audioAnalyser.connect(this.local.delayNode);
        this.local.delayNode.connect(this.local.gainNode);
        this.local.gainNode.connect(this.local.streamNode);

        // setInterval(this.processAudio.bind(this), 5);

        //Begin Camera setup
        // this.registerMessageType("camStatus", this.remoteCamChanged);

        //Create a canvas and add the noVideoImage to it, then capture the stream 
        this.local.novideoCanvas.style.display = "none";
        this.noVideoStream = this.local.novideoCanvas.captureStream ? this.local.novideoCanvas.captureStream() : this.local.novideoCanvas.mozCaptureStream();

        this.local.noCamImage.src = this.noVideoImageLink;
        this.local.noCamImage.onload = this.noVideoImgFinished.bind(this);
        this.local.video = this.noVideoStream;
        this.local.videoElement.srcObject = this.local.video;

        // this.registerMessageType("chat", this.receivedChatMessage);
    }

    //SCALEDRONE/JOINING

    /**
     * Join the specified scaledrone room and start webrtc if someone else is there
     * 
     *@param {string} droneKey - The API key to access scaledrone
     * 
     *@param {string} roomCode - The room you want to join
     * 
     *@param {string} myName - The name you would like to be seen as
     * 
     */
    join(droneKey, roomCode, myName) {

        this.local.name = myName;
        this.drone = new ScaleDrone(droneKey, {
            data: {
                name: this.local.name
            }
        });
        this.roomCode = "observable-" + roomCode;
        this.drone.on("open", this.droneInit.bind(this));

    }

    /**
     * Initializes the drone and connects to the room (internal)
     */
    droneInit() {
        this.room = this.drone.subscribe(this.roomCode);
        this.local.id = this.drone.clientId;
        this.room.on('member_join', this.memberJoinedRoom.bind(this));
        this.room.on('member_leave', this.memberLeftRoom.bind(this));
    }

    memberJoinedRoom(member) {

        if (!this.remotes.hasOwnProperty(member.id)) this.init_remote(member.id, member.clientData.name, true);

    }

    memberLeftRoom(member) {
        remote = this.remotes[member.id];
        remote.videoElement.parentNode.removeChild(remote.videoElement);
        remote.audioElement.parentNode.removeChild(remote.audioElement);
        this.callEvent('memberLeft', {
            id: remote.id,
            name: remote.name
        });
        remote.channel.close();
        remote.pc.close();
    }

    //Events

    /**
     * Run to call an event by name, does nothing if event doesn't exist
     */
    callEvent(name, eventData={}){
        if (this.on.hasOwnProperty(name)){
            this.on[name](this, eventData);
        } else {
            if (DEBUG) console.warn("Event: " + name + " is not defined!");
        }
    }
    
    /**
     * Run as a shortcut to run an event as a callback
     */
    callEventAsCallBack(name, eventData={}){
        return function(){document.comm.callEvent(name, eventData);}
    }

    //MESSAGES/SIGNALS

    /**
     * Register a function to be run if the Comm receives a signal over scaledrone with the specified type
     */
    registerSignalType(type, func) {
        this.signalTypes[type] = func.bind(this);
    }

    /**
     * Register a function to be run if the Comm receives a message over the datachannel with the specified type
     */
    registerMessageType(type, func) {
        this.messageTypes[type] = func.bind(this);
    }

    /**
     * Send a signal with the specified type
     */
    sendSignal(type, content) {
        if (this.joined) {
            this.drone.publish({
                room: this.roomCode,
                message: {
                    type,
                    content
                }
            });
        }
    }

    /**
     * Send a message with the specified type
     */
    sendMessage(type, content, remote) {
        let ctn = {
            id: this.id,
            type,
            content
        }

        let data = JSON.stringify(ctn);

        if (remote.channel !== null) {
            remote.channel.send(data);
        }
    }

    roomDataReceived(message, client) {
        if (client.id !== this.drone.clientId) this.signalTypes[message.type](message.content, client, this);
    }

    // Remote Managment

    init_remote(id, name, offerer) {

        let new_remote = new RemoteData(id, name, this.peerConfig, this.local, offerer, this.noVideoStream);

        // Allow the user to move the element to whatever node they desire
        this.callEvent("makeRemoteElements", {
            'video': new_remote.videoElement,
            'audio': new_remote.audioElement
        });

        // Initialize PeerConnection events
        new_remote.pc.onicecandidate = this.pcCandidate.bind({
            'comm': this,
            'remote': new_remote
        });
        new_remote.pc.ontrack = this.pcTrackReceived.bind({
            'comm': this,
            'remote': new_remote
        });
        new_remote.pc.ondatachannel = this.pcChannelReceived.bind({
            'comm': this,
            'remote': new_remote
        });

        this.remotes[id] = new_remote;

        if (offerer) {
            new_remote.pc.onnegotiationneeded = () => {
                new_remote.pc.createOffer().then(this.sdpSuccessful.bind({
                    'comm': this,
                    'remote': new_remote
                }));
            }
        }

        return new_remote;

    }

    // SDP

    receiveSdp(data, client, me) {
        if (data.intended === this.id) {
            let remote = undefined;
            let offerer = (this.remotes.hasOwnProperty(client.id));
            if (offerer) {
                remote = this.remotes[client.id];
            } else {
                remote = this.init_remote(client.id, client.clientData.name, false);
            }
            remote.pc.setRemoteDescription(new RTCSessionDescription(data.desc)).then(this.makeSdpAnswer.bind({
                'comm': this,
                'remote': remote,
                'offerer': offerer
            }));
        }
    }

    sdpSuccessful(description) {
        this.remote.pc.setLocalDescription(description).then(this.comm.sendSdp.bind({
            comm: this.comm,
            remote: this.remote
        }));
        if (this.comm.local.micOn) this.sendMessage("micStatus", true, this.remote);
        if (this.comm.local.camOn) this.sendMessage("camStatus", true, this.remote);
    }

    makeSdpAnswer() {
        if (!this.offerer) {
            this.remote.pc.createAnswer().then(this.comm.sdpSuccessful.bind({
                comm: this.comm,
                remote: this.remote
            }));
        }
    }

    sendSdp() {
        this.comm.sendSignal('sdp', {
            desc: this.remote.pc.localDescription,
            intended: this.remote.id
        });
    }

    // ICE CANDIDATES

    pcCandidate(event) {
        if (event.candidate) {
            this.comm.sendSignal('candidate', {
                'candidate': event.candidate,
                'intended': this.remote.id
            });
        }
    }

    candidateReceived(data, client, me) {
        if (DEBUG) console.log(this.pc.remoteDescription);
        if (data.intended === this.id) this.remotes[client.id].pc.addIceCandidate(new RTCIceCandidate(data.candidate));
    }

    // TRACKS

    pcTrackReceived(event) {
        const stream = event.streams[0];
        if (event.track.kind == "video") {
            let newStream = new MediaStream([event.track]);
            this.remote.videoElement.srcObject = this.remote.camOn ? newStream : this.comm.noVideoStream;
        } else if (event.track.kind == "audio") {
            this.remote.audioElement.srcObject = new MediaStream([event.track]);
        }
    }

    // CHANNELS

    pcChannelReceived(event) {
        this.remote.channel = event.channel;
        this.remote.channel.onmessage = this.comm.pcChannelData.bind(this);
        this.channelInitialized = true;
    }

    pcChannelData(event) {
        let data = JSON.parse(event.data);
        let client = {
            clientData: {
                id: data.id
            }
        };
        this.messageTypes[data.type](data.content, client, me);
    }

    // AUDIO

    // VIDEO

    noVideoImgFinished(){
        this.local.novideoCanvas.width = this.local.noCamImage.width;
        this.local.novideoCanvas.height = this.local.noCamImage.height;
        this.local.novideoContext.drawImage(this.local.noCamImage, 0, 0);
    }

}