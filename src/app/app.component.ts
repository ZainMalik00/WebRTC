import { Component, ElementRef, Signal, ViewChild, WritableSignal, computed, effect, inject, signal } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { Firestore, addDoc, collection, deleteDoc, doc, docSnapshots, getDoc, getDocs, setDoc } from '@angular/fire/firestore';
@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet],
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss'
})
export class AppComponent {
  title = 'webrtc';
  
  firestore: Firestore = inject(Firestore);

  @ViewChild("localVideo", {static: true}) localVideo!: ElementRef<HTMLVideoElement>;
  @ViewChild("remoteVideo") remoteVideo !: ElementRef<HTMLVideoElement>;
  // @ViewChild("currentRoom") currentRoom !: string;

  peerConnection!: RTCPeerConnection;
  localStream!: MediaStream;
  remoteStream!: MediaStream;
  roomDialog = null;
  roomId!: string;
  currentRoom!: string;

  isUserMediaSetup: WritableSignal<boolean> = signal(false);
  hasCreatedRoom: WritableSignal<boolean> = signal(false);
  hasJoinedRoom: WritableSignal<boolean> = signal(false);

  canCreateRoom: Signal<boolean> = computed(() => {
    if(this.isUserMediaSetup() && !this.hasCreatedRoom() && !this.hasJoinedRoom()){
      return true;
    }
    return false;
  });
  
  canJoinRoom: Signal<boolean> = computed(() => {
    if(this.isUserMediaSetup() && !this.hasCreatedRoom() && !this.hasJoinedRoom()){
      return true;
    }
    return false;
  });

  canHangUp: Signal<boolean> = computed(() => {
    if(this.isUserMediaSetup() && (this.hasCreatedRoom() || this.hasJoinedRoom())){
      return true;
    }
    return false;
  });

  constructor() {
  }

  ngOnInit(): void{
    this.isUserMediaSetup.set(false);
    this.hasCreatedRoom.set(false);
    this.hasJoinedRoom.set(false);
 }

 ngAfterViewInit() {}

  ngOnDestroy() {
    (this.localVideo.nativeElement.srcObject as MediaStream).getVideoTracks()[0].stop();
    this.deregisterPeerConnectionListeners();
  }

  configuration = {
    iceServers: [
      {
        urls: [
          'stun:stun1.l.google.com:19302',
          'stun:stun2.l.google.com:19302',
        ],
      },
    ],
    iceCandidatePoolSize: 10,
  }

  async openUserMedia() {
    navigator.mediaDevices.getUserMedia({video: true, audio: true}).then(stream => {
      this.localVideo.nativeElement.srcObject = stream;
      this.localStream = stream;
      this.localVideo.nativeElement.play();
      this.isUserMediaSetup.set(true);
    });;

  }

  closeUserMedia() {
    this.localVideo.nativeElement.pause();
    (this.localVideo.nativeElement.srcObject as MediaStream).getVideoTracks()[0].stop();
    this.localVideo.nativeElement.srcObject = null;
    this.isUserMediaSetup.set(false);
  };

  async createRoom() {

    this.hasCreatedRoom.set(true);
    this.createPeerConnection();

    // Code for creating a room
    const offer = await this.peerConnection.createOffer();
    await this.peerConnection.setLocalDescription(offer);
    console.log('Created offer:', offer);
  
    const roomOffer = {
      'offer': {
        type: offer.type,
        sdp: offer.sdp,
      }
    };

    await addDoc(collection(this.firestore, 'rooms'), roomOffer)
      .then((room: any) => {
        console.log("Created room with ID: ", room.id);
        this.roomId = room.id;
        console.log(`New room created with SDP offer. Room ID: ${room.id}`);
        this.currentRoom = `Current room is ${room.id} - You are the caller!`;
      })
      .catch(error => {
        console.error("Error creating room: ", error);
      });

    this.peerConnection.addEventListener('track', event => {
      console.log('Got remote track:', event.streams[0]);
      event.streams[0].getTracks().forEach(track => {
        console.log('Add a track to the remoteStream:', track);
        this.remoteStream.addTrack(track);
      });
    });
  
    this.collectCallerCandidates();

    // Listening for remote session description below
    docSnapshots(doc(this.firestore, 'rooms', this.roomId)).subscribe((async (snapshot: any) => {
      const data = snapshot.data();
      if (!this.peerConnection.currentRemoteDescription && data && data.answer) {
        console.log('Got remote description: ', data.answer);
        const rtcSessionDescription = new RTCSessionDescription(data.answer);
        await this.peerConnection.setRemoteDescription(rtcSessionDescription);
      }
    }));
  
    // Listen for remote ICE candidates below
    docSnapshots(doc(this.firestore, 'rooms', this.roomId, 'callerCandidates')).subscribe(async (snapshot: any) => {
      snapshot.docChanges().forEach(async (change: { type: string; doc: { data: () => any; }; }) => {
        if (change.type === 'added') {
          let data = change.doc.data();
          console.log(`Got new remote ICE candidate: ${JSON.stringify(data)}`);
          await this.peerConnection.addIceCandidate(new RTCIceCandidate(data));
        }
      });
    });
  }

  joinRoom() {
    this.hasJoinedRoom.set(true);
  
    // document.querySelector('#confirmJoinBtn').
    //     addEventListener('click', async () => {
    //       roomId = document.querySelector('#room-id').value;
    //       console.log('Join room: ', roomId);
    //       document.querySelector(
    //           '#currentRoom').innerText = `Current room is ${roomId} - You are the callee!`;
    //       await joinRoomById(roomId);
    //     }, {once: true});
    // roomDialog.open();
  }

  async hangUp() {

    this.hasCreatedRoom.set(false);
    this.hasJoinedRoom.set(false);
    this.currentRoom = '';

    this.localStream.getTracks().forEach(track => {
      track.stop();
    });
  
    if (this.remoteStream) {
      this.remoteStream.getTracks().forEach(track => track.stop());
    }
  
    if (this.peerConnection) {
      this.peerConnection.close();
    }
  
    // Delete room on hangup
    if (this.roomId) {

      await getDocs(collection(this.firestore, 'rooms', this.roomId, 'callerCandidates'))
      .then((callerCandidates: any) => {
        callerCandidates.forEach(async (callerCandidate: any) => {
          await deleteDoc(doc(this.firestore, 'rooms', this.roomId, 'callerCandidates', callerCandidate.id));
        });
      }).catch(error => {
        console.error("No CallerCandidates to delete.", error);
      });

      await getDocs(collection(this.firestore, 'rooms', this.roomId, 'calleeCandidates'))
      .then((calleeCandidates: any) => {
        calleeCandidates.forEach(async (calleeCandidate: any) => {
          await deleteDoc(doc(this.firestore, 'rooms', this.roomId, 'calleeCandidates', calleeCandidate.id));
        });
      }).catch(error => {
        console.error("No CallerCandidates to delete.", error);
      });

      await deleteDoc(doc(this.firestore, 'rooms', this.roomId));
    }
  
    // document.location.reload();
  }

  createPeerConnection(){
    console.log('Create PeerConnection with configuration: ', this.configuration);
    this.peerConnection = new RTCPeerConnection(this.configuration);
  
    this.registerPeerConnectionListeners();
  
    this.localStream.getTracks().forEach(track => {
      this.peerConnection.addTrack(track, this.localStream);
    });
  }

  collectCallerCandidates(){
    const callerCandidatesCollection = collection(this.firestore, 'rooms', this.roomId, 'callerCandidates');
  
    this.peerConnection.addEventListener('icecandidate', async event => {
      if (!event.candidate) {
        console.log('Got final candidate!');
        return;
      }
      console.log('Got candidate: ', event.candidate);
      await addDoc(callerCandidatesCollection, event.candidate.toJSON());
    });
  };

  registerPeerConnectionListeners() {
    this.peerConnection.addEventListener('icegatheringstatechange', () => {
      console.log(
          `ICE gathering state changed: ${this.peerConnection.iceGatheringState}`);
    });
  
    this.peerConnection.addEventListener('connectionstatechange', () => {
      console.log(`Connection state change: ${this.peerConnection.connectionState}`);
    });
  
    this.peerConnection.addEventListener('signalingstatechange', () => {
      console.log(`Signaling state change: ${this.peerConnection.signalingState}`);
    });
  
    this.peerConnection.addEventListener('iceconnectionstatechange ', () => {
      console.log(
          `ICE connection state change: ${this.peerConnection.iceConnectionState}`);
    });
  };

  deregisterPeerConnectionListeners() {
    this.peerConnection.removeEventListener('track', ()=> {});
    this.peerConnection.removeEventListener('icecandidate', () => {});
    this.peerConnection.removeEventListener('icegatheringstatechange', () => {});
    this.peerConnection.removeEventListener('connectionstatechange', ()=> {});
    this.peerConnection.removeEventListener('signalingstatechange', () => {});
    this.peerConnection.removeEventListener('iceconnectionstatechange', () => {});
  };

}
