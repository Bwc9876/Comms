'use strict';

/*

  ==Comms.js - A simple 2 person webrtc wrapper that uses scaledrone==

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
  facingMode : "user"
}

//The default video options to be passed to getUserMedia when turning on the microphone
const DEFAULT_AUDIO_OPTIONS = {
  noiseSuppression : true
}

//Used to store data and objects relating to our user
class LocalData {
  constructor(video, context){
    Object.defineProperties(this, {
      'videoElement' : {value: video},
      'micOn': {value: false, writable: true},
      'camOn' : {value: false, writable: true},
      'micActivity' : {value: false, writable: true},
      'noAudioNode': {value: context.createOscillator()},
      'audio': {value:null, writable:true, configurable:true},
      'audioAnalyser': {value: context.createAnalyser()},
      'micNode': {value: null, writable: true, configurable: true},
      'gainNode': {value: context.createGain()},
      'noiseGateNode': {value:null, writable:true, configurable:true},
      'delayNode': {value: context.createDelay()},
      'streamNode': {value: context.createMediaStreamDestination()},
      'novideoCanvas': {value: document.createElement("canvas")},
      'noCamImage': {value: new Image()},
      'video': {value:null, writable:true, configurable:true},
      'name': {value:"NULL", writable:true}
    });
    Object.defineProperty(this, 'novideoContext', {value: this.novideoCanvas.getContext("2d")});
  }
}

//Used to store data and objects relating to the other user
class RemoteData {
  constructor (video, audio) {
    Object.defineProperties(this,
      {
        'videoElement' : {value: video},
        'audioElement' : {value: audio},
        'micOn': {value: false, writable: true},
        'camOn' : {value: false, writable: true},
        'id' : {value: "NULL", writable:true},
        'name' : {value: "NULL", writable:true}
      }
    );
  }
}

/**
 * @class Comm
 * The main class of this library, use it to conect with webrtc
 * 1. Call the constructor, supplying the corrent args
 * 2. Initialize any event handlers or buttons
 * 3. Call init()
 * 4. Call join() (this actually connects to scaledrone and inits webrtc, so its recommended you call this after a button press)
 */
export default class Comm {

  /**
  * Use this to make a new Comm object, then call init() and join()
  *
  *@param {video} localVideo - The video element representing the user's camera
  *
  *@param {video} remoteVideo - The video element representing the other user's camera
  *
  *@param {audio} remoteAudio - The audio element representing the other user's microphone
  * 
  *@param {URL} noVideoImage - A link to an image that will be displayed when the user's camera is off
  *
  *@param {object} events - A dictionary (string->function) that represents the events you'd like to interface with
  *
  *@param {RTCConfiguration} config (optional) - A RTCConfiguration object that tells the PeerConnection how to connect, will use google's STUN servers by default
  */
  constructor(localVideo, remotevideo, remoteAudio, noVideoImage, events, config=DEFAULT_CONFIG){
    
    this.signalTypes = {};
    this.messageTypes = {};

    this.audioContext = new AudioContext();

    this.local = new LocalData(localVideo, this.audioContext);
    this.remote = new RemoteData(remotevideo, remoteAudio);
    this.noVideoImageLink = noVideoImage;

    Object.defineProperties(this, {
      "peerConfig": {value:config, writable:false},
      "on": {value:events, writable:false}
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
  init(videoOptions=DEFAULT_VIDEO_OPTIONS, audioOptions=DEFAULT_AUDIO_OPTIONS, audioThreshold=DEFAULT_AUDIO_THRESHOLD) {

    this.videoOptions = videoOptions;
    this.audioOptions = audioOptions;
    this.audioThreshold = audioThreshold;

    this.queued = [];
    this.pc = new RTCPeerConnection(this.peerConfig);
    this.registerSignalType("sdp", this.receiveSdp.bind(this));
    this.registerSignalType("sdpComplete", this.otherSdpCompleted.bind(this));
    this.registerSignalType("candidate", this.candidateReceived.bind(this));

    //Begin Audio setup
    this.registerMessageType("micStatus", this.remoteMicChanged);
    this.registerMessageType("activityChanged", this.remoteActivityChange);

    this.local.audioAnalyser.smoothingTimeConstant = 0.5;
    this.local.gainNode.gain.value = 1;
    this.local.delayNode.delayTime.value = 0.05;
    this.local.micNode = this.local.noAudioNode;
    this.local.micNode.connect(this.local.audioAnalyser);
    this.local.audioAnalyser.connect(this.local.delayNode);
    this.local.delayNode.connect(this.local.gainNode);
    this.local.gainNode.connect(this.local.streamNode);

    setInterval(this.processAudio.bind(this), 5);

    //Begin Camera setup
    this.registerMessageType("camStatus", this.remoteCamChanged);

    //Create a canvas and add the noVideoImage to it, then capture the stream 
    this.local.novideoCanvas.style.display = "none";
    this.noVideoStream = this.local.novideoCanvas.captureStream? this.local.novideoCanvas.captureStream() : this.local.novideoCanvas.mozCaptureStream();

    this.local.noCamImage.src = this.noVideoImageLink;
    this.local.noCamImage.onload = this.noVideoImgFinished.bind(this);
    this.local.video = this.noVideoStream;
    this.local.videoElement.srcObject = this.local.video;

    this.sdpDone = false;
    this.candidateQueue = [];

    this.registerMessageType("chat", this.receivedChatMessage);
  }

  //Events

  /**
   * Run to call an event by name, does nothing if event doesn't exist
   */
  callEvent(name, eventData={}){
    try{
      this.on[name](this, eventData);
    } catch (TypeError) {
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
  registerSignalType(type, func){
    this.signalTypes[type] = func.bind(this);
  }

  /**
   * Register a function to be run if the Comm receives a message over the datachannel with the specified type
   */
  registerMessageType(type, func){
    this.messageTypes[type] = func.bind(this);
  }
  
  /**
   * Send a signal with the specified type
   */
  sendSignal(type, content){
    if (this.joined){
      this.drone.publish({
        room: this.roomCode,
        message: {type, content}
      });
    }
  }

  /**
   * Send a message with the specified type
   */
  sendMessage(type, content){
      let ctn = {
        name : this.local.name,
        type,
        content
      }

      let data = JSON.stringify(ctn);

      if (this.channelInitialized){
        this.dataChannel.send(data);
      } else {
        this.queued.push(data);
      }
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
  join(droneKey, roomCode, myName){

    this.local.name = myName;
    this.drone = new ScaleDrone(droneKey, {data: {name:this.local.name}});
    this.roomCode = "observable-" + roomCode;
    this.drone.on("open", this.droneInit.bind(this));

  }

  /**
   * Called when a member leaves the scaledrone room.
   * If it's the other person then we need to reset many variables (internal)
   */
  memberLeftRoom(member){
    let me = document.comm;
    if (this.joined && member.id == this.remote.id){
      //First, we're going to reset a lot of variables
      this.remote.micActivity = false;
      this.remote.micOn = false;
      this.remote.camOn = false;
      this.remote.videoElement.srcObject = null;
      this.isOfferer = false;
      this.local.videoSender = null;
      this.local.audioSender = null;
      this.remote.id = "NULL";
      this.callEvent("otherLeave", {otherName: this.remote.name});
      this.remote.name = "NULL";
      //And now we start calling events to update any needed info
      this.dataChannel.close();
      this.dataChannel = null;
      this.callEvent("remoteMicActivityChanged", {newMicActivity: false});
      this.remote.videoElement.load();
      this.pc.close();
      this.pc = null;
      //Finally, we reset the peerconnection and re-initialize WebRTC
      this.pc = new RTCPeerConnection(this.peerConfig);
      this.initRTC();
    }
  }

  /**
   * Initializes the drone and connects to the room (internal)
   */
  droneInit(){
    this.room = this.drone.subscribe(this.roomCode);
    this.local.id = this.drone.clientId;
    this.room.on('members', this.roomMembers.bind(this));
    this.room.on('member_leave', this.memberLeftRoom.bind(this));
  }

  /**
   * Run whenever the drone receives new data (internal)
   */
  roomDataReceived(message, client){
    if (client.id !== this.drone.clientId) this.signalTypes[message.type](message.content, client, this);
  }

  /**
   * When someone joins the room, check if they're allowed to (internal)
   */
  roomMembers(members){
    let valid = true;
    let reason = "none";

    members.forEach(member => {
      if (this.local.id != member.id && this.local.name == member.clientData.name){
        valid = false;
        reason = "Person already in meeting";
      }
    });

    if(members.length > 2){
      valid = false;
      reason = "Meeting Full";
    }

    this.isOfferer = members.length === 2;
    if (valid){
      this.initRTC();
    } else {
      this.callEvent("cantJoin", {reason});
    }
  }

  //Streams

  /**
   * Begins sending audio and video streams via WebRTC (internal)
   */
  initializeStreams(){
    this.audioSender = this.pc.addTrack(this.local.streamNode.stream.getAudioTracks()[0]);
    this.videoSender = this.pc.addTrack(this.local.video.getVideoTracks()[0]); 
  }

  //WebRTC

  /**
   * Run to begin the sdp and ice transfer process (internal)
   */
  initRTC(){
    console.log(this.isOfferer? "OFFERER" : "ANSWERER");
    //General flow of the sdp process
    // Offerer sends sdp -> Receiver receives and registers -> Receiver sends back sdp -> Offerer received and registers -> Begin ICE transfer

    this.pc.onicecandidate = this.pcCandidate.bind(this);
    this.pc.ontrack = this.pcTrackReceived.bind(this);
    this.initializeStreams();
    this.pc.ondatachannel = this.pcChannelReceived.bind(this);
    this.initChannel();

    if (this.isOfferer){
      this.pc.onnegotiationneeded = () => {
        this.pc.createOffer().then(this.sdpSuccessful.bind(this));
      }
    }

    this.room.on('data', this.roomDataReceived.bind(this));

    this.joined = true;

  }

  /**
   * Run whenever we recieve a track (audio or video) from the other Comm (internal)
   */
  pcTrackReceived(event){
    const stream = event.streams[0];
    let me = document.comm;
    if (event.track.kind == "video"){
      let newStream = new MediaStream([event.track]);
      this.remote.video = newStream;
      this.remote.videoElement.srcObject = this.remote.camOn? newStream : this.noVideoStream;
    }
    else if (event.track.kind == "audio"){
      this.remote.audioElement.srcObject = new MediaStream([event.track]);
    }
  }

  //DATA CHANNELS

  /**
   * Any messages sent before the channel was initalied will be sent now (internal)
   */
  channelCatchUp(){
    this.queued.forEach(ctn => {
      this.dataChannel.send(ctn);
    });
    this.queued = [];
  }

  /**
   * Run when the channel is open (internal)
   */
  channelOpen(event){
    let me = document.comm;
    this.channelInitialized = true;
    this.channelCatchUp();
  }

  /**
   * Initializes the data channel to send data after connecting to a peer (internal)
   */
  initChannel(){
    this.dataChannel = this.pc.createDataChannel("Healine Data Channel");
    this.dataChannel.onopen = this.channelOpen.bind(this);
    this.dataChannel.onmessage = this.pcChannelData.bind(this);
  }

  /**
   * Run when the other Comm makes a channel for communication (internal)
   */
  pcChannelReceived(event){
    let me = document.comm;
    this.dataChannel = event.channel;
    this.dataChannel.onmessage = this.pcChannelData.bind(this);
    this.channelInitialized = true;
  }

  pcChannelData(event){
    let me = document.comm;
    let data = JSON.parse(event.data);
    let client = {clientData:{name:data.name}};
    this.messageTypes[data.type](data.content, client, me);
  }

  //SDP

  /**
   * Run when the Comm receives an sdp message (internal) 
   */
  receiveSdp(desc, client, me){
    this.remote.id = client.id;
    this.remote.name = client.clientData.name;
    this.pc.setRemoteDescription(new RTCSessionDescription(desc)).then(this.makeSdpAnswer.bind(this));
    if (this.isOfferer) {
      this.sdpDone = true;
      this.candidateCatchup();
      this.sendSignal("sdpComplete", true);
    }
  }

  otherSdpCompleted(complete, client, me){
    this.sdpDone = complete;
    this.candidateCatchup();
  }

  /**
   * This will answer an incoming sdp request if this Comm isn't the one that made the offer (internal)
   */
  makeSdpAnswer(){
    let me = document.comm;
    if (!this.isOfferer){
      this.pc.createAnswer().then(this.sdpSuccessful.bind(this));
    }
  }

  /**
   * This will be run by both the offerer and the receiver when they've sucesfully contacted eachother (internal)
   */
  sdpSuccessful(description){
    let me = document.comm;
    this.pc.setLocalDescription(description).then(this.pcCallback.bind(this));
    if (this.local.micOn) this.sendMessage("micStatus", true);
    if (this.local.camOn) this.sendMessage("camStatus", true);
  }

  /**
   * Sends the sdp info to the other Comm (internal)
   */
  pcCallback(){
    this.sendSignal('sdp', this.pc.localDescription);
  }

  //ICE

  /**
   * Run when the PeerConnection has a new candidate available (internal)
   */
  pcCandidate(event){
    let me = document.comm;
    if (event.candidate) {
      if (this.sdpDone){
        this.sendSignal('candidate', event.candidate);
      } else {
        this.candidateQueue.push(event.candidate);
      }
    }
  }

  /**
   * Run when we've received a candidate thorugh signalling (internal)
   */
  candidateReceived(can, client, me){
    console.log(this.pc.remoteDescription);
    this.pc.addIceCandidate(new RTCIceCandidate(can));
  }

  /**
   * Run when the sdp process has completed, sends any backlogged candidates (internal)
   */
  candidateCatchup(){
    for(let i=0;i<this.candidateQueue.length;i++){
      this.sendSignal("candidate", this.candidateQueue[i]);
    }
    this.candidateQueue = [];
  }

  //Chat System

  sendChatMessage(message){
    this.sendMessage("chat", message);
  }

  receivedChatMessage(message, sender, me){
    this.callEvent("chatMessage", {message: message, senderName: sender.clientData.name});
  }

  //Microphone

  /**
   * Change the mic being enabled
   * 
   *@param {boolean} enabled - Whether or not to send mic data
   */
  changeMicStatus(enabled){

    if (enabled){
      navigator.mediaDevices.getUserMedia({audio: this.audioOptions}).then(stream => {
        this.local.audio = stream;
        this.switchMicNode(this.audioContext.createMediaStreamSource(stream));
        this.local.micOn = true;
        this.callEvent("micStatusChanged", {newMicStatus: true});
        if (this.joined) this.sendMessage("micStatus", true);
      }, this.callEventAsCallBack("micError").bind(this));
    } else {
      this.local.audio.getAudioTracks()[0].stop();
      this.local.audio = null;
      this.switchMicNode(this.local.noAudioNode);
      this.local.micOn = false;
      this.callEvent("micStatusChanged", {newMicStatus: false});
      if (this.joined) this.sendMessage("micStatus", false);
    }

  }

  /**
   * Change the microphones's settings
   * 
   * @param {MediaStreamConstraints} newSettings - The new microphone settings to put in
   */
  changeMicSettings(newSettings){
    this.audioOptions = newSettings;
    this.changeMicStatus(this.local.micOn);
  }

  /**
   * Toggle the mic to be on or off
   */
  toggleMic(){
    this.changeMicStatus(!this.local.micOn);
  }

  /**
   * Switches out the current node thats going through webrtc to another one (internal)
   */
  switchMicNode(newNode){
    this.local.micNode.disconnect(this.local.audioAnalyser);
    this.local.micNode = newNode;
    this.local.micNode.connect(this.local.audioAnalyser);
  }

  /**
   * Called when the other user changes their muted status (internal)
   */
  remoteMicChanged(status, client, me){
    this.remote.micOn = status;
    this.callEvent("remoteMicChange", {newMicStatus: status});
  }

  /**
   * Called every millisecond to check mic activity and determine whether the mic is active
   */
  processAudio(){
    let me = document.comm;
    let array = new Uint8Array(this.local.audioAnalyser.frequencyBinCount);
    this.local.audioAnalyser.getByteFrequencyData(array);
    let values = 0;
    let average
    let length = array.length
    // get all the frequency amplitudes
    for (let i = 0; i < length; i++) {
        values += array[i];
    }
    average = values / length;
    let micActive = this.local.micOn && average > this.audioThreshold;
    if (micActive != this.local.micActivity){
      this.local.micActivity = micActive;
      this.local.gainNode.gain.value = this.local.micActivity? 1 : 0;
      this.callEvent("localMicActivityChanged", {newMicActivity:micActive});
      if (this.joined) this.sendMessage("activityChanged", this.local.micActivity);
    }
  }

  /**
   * Use this to change the point at which audio will be sent
   * 
   *@param {float} newThreshold - Anything below this value will not be sent through WebRTC
   * 
   */
  setAudioThreshold(newThreshold){
    this.audioThreshold = newThreshold;
  }

  /**
   * Called when the other person's mic activity changed (internal)
   */
  remoteActivityChange(active, client, me){

    this.remote.micActivity = active;
    this.callEvent("remoteMicActivityChanged", {newMicActivity:active});

  }

  //Camera

  /**
   * Change the camera being enabled
   * 
   *@param {boolean} enabled - Whether or not to send camera data
   */  
  changeCamStatus(enabled){
    if (this.local.video != this.noVideoStream) this.local.video.getVideoTracks()[0].stop();
    if (enabled){
      navigator.mediaDevices.getUserMedia({video: this.videoOptions}).then(stream => {
        this.local.video = stream;
        this.local.videoElement.srcObject = this.local.video;
        this.callEvent("camStatusChanged", {newCamStatus: true});
        this.local.camOn = true;
        if (this.joined) {
          this.videoSender.replaceTrack(this.local.video.getVideoTracks()[0]);
          this.sendMessage("camStatus", true);
        }
      }).catch(this.callEventAsCallBack("camError").bind(this));
    } else {
      this.local.video = this.noVideoStream;
      this.local.videoElement.srcObject = this.local.video;
      this.callEvent("camStatusChanged", {newCamStatus: false});
      this.local.camOn = false;
      if (this.joined) {
        this.videoSender.replaceTrack(this.local.video.getVideoTracks()[0]);
        this.sendMessage("camStatus", false);
      }
    }
  }

  /**
   * Change the camera's settings
   * 
   * @param {MediaStreamConstraints} newSettings - The new camera settings to put in
   */
  changeCameraSettings(newSettings){
    this.videoOptions = newSettings;
    this.changeCamStatus(this.local.camOn);
  }

  /**
   * Flip the camera (mobile only)
   * 
   * Will do nothing if the current facingMode is undefined
   */
  flipCamera(){
    if (this.local.camOn){
      let newOptions = this.videoOptions;

      if (newOptions.facingMode == "environment") {
        newOptions.facingMode = "user";
      }
      else if (newOptions.facingMode == "user"){
        newOptions.facingMode = "environment";
      }

      this.changeCameraSettings(newOptions);
    }
  }

  /**
   * Toggle camera on or off
   */
  toggleCam(){
    this.changeCamStatus(!this.local.camOn);
  }

  /**
   * Called when the other user changes their camera status (internal)
   */
  remoteCamChanged(status, client, me){
    this.remote.camOn = status;
    this.callEvent("remoteCamChange", {newCamStatus: status});
    this.remote.videoElement.srcObject = this.remote.camOn? this.remote.video : this.noVideoStream;
  }

  /**
   * Used when we succesfully get the image that represents no video (internal)
   */
  noVideoImgFinished(){
    let me = document.comm;
    this.local.novideoCanvas.width = this.local.noCamImage.width;
    this.local.novideoCanvas.height = this.local.noCamImage.height;
    this.local.novideoContext.drawImage(this.local.noCamImage, 0, 0);
  }
  
}
