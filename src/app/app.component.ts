import { Component, ElementRef, Signal, ViewChild, WritableSignal, computed, effect, inject, signal } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { Firestore, addDoc, collection, deleteDoc, doc, docSnapshots, getDoc, getDocs, onSnapshot, query, updateDoc, where } from '@angular/fire/firestore';
import { FormsModule, ReactiveFormsModule, FormControl, FormGroup } from '@angular/forms';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, FormsModule, ReactiveFormsModule],
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss'
})
export class AppComponent {
  title = 'webrtc';
  firestore: Firestore = inject(Firestore);

  @ViewChild("localVideo", {static: true}) localVideo!: ElementRef<HTMLVideoElement>;
  @ViewChild("remoteVideo", {static: true}) remoteVideo !: ElementRef<HTMLVideoElement>;

  peerConnection!: RTCPeerConnection;
  localStream!: MediaStream;
  remoteStream!: MediaStream;
  roomId!: string;
  currentRoom!: string;

  isUserMediaSetup: WritableSignal<boolean> = signal(false);
  hasCreatedRoom: WritableSignal<boolean> = signal(false);
  hasJoinedRoom: WritableSignal<boolean> = signal(false);
  showJoinRoomForm: WritableSignal<boolean> = signal(false);

  canCreateRoom: Signal<boolean> = computed(() => {
    if(this.isUserMediaSetup() && !this.hasCreatedRoom() && !this.hasJoinedRoom()){
      return true;
    }
    return false;
  });
  
  canJoinRoom: Signal<boolean> = computed(() => {
    if(this.isUserMediaSetup() && !this.hasCreatedRoom() && !this.hasJoinedRoom() && !this.showJoinRoomForm()){
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

  joinRoomForm = new FormGroup({
    newRoomId: new FormControl<string>("")
  });

  ngOnInit(): void{
    this.isUserMediaSetup.set(false);
    this.hasCreatedRoom.set(false);
    this.hasJoinedRoom.set(false);
    this.remoteStream = new MediaStream();
 }

 ngAfterViewInit() {
  this.remoteVideo.nativeElement.srcObject = this.remoteStream;
 }

  ngOnDestroy() {
    (this.localVideo.nativeElement.srcObject as MediaStream).getVideoTracks()[0].stop();
    (this.remoteVideo.nativeElement.srcObject as MediaStream).getVideoTracks()[0].stop();
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
    this.showJoinRoomForm.set(false);
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

    this.setupRemoteStreamListener();
  
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
    const queryCalleeCandidates = query(collection(this.firestore, 'rooms', this.roomId, 'calleeCandidates'), where("sdpMid", ">=", "0"));
    onSnapshot(queryCalleeCandidates, (snapshot) => {
      snapshot.docChanges().forEach(async (change: { type: string; doc: { data: () => any; }; }) => {
        if (change.type === 'added') {
          let data = change.doc.data();
          console.log("Got new remote ICE candidate: ", data);
          await this.peerConnection.addIceCandidate(new RTCIceCandidate(data));
        }
      });
    });
  }

  openJoinRoomForm() {
    this.showJoinRoomForm.set(true);
  }

  async joinRoom() {
    this.showJoinRoomForm.set(false);
    this.hasJoinedRoom.set(true);

    let joinOffer: any;

    await getDoc(doc(this.firestore, 'rooms', this.joinRoomForm.getRawValue().newRoomId?.toString()!))
      .then((room: any) => {
        console.log('Found Room:', room.id);
        this.roomId = room.id;
        joinOffer = room.data().offer;
      }).catch(error => {
        console.error("Unable to Find Room", error);
      });

      if(this.roomId){
        this.peerConnection = new RTCPeerConnection(this.configuration);
        this.registerPeerConnectionListeners();

        this.localStream.getTracks().forEach(track => {
              this.peerConnection.addTrack(track, this.localStream);
        });

        // Code for collecting ICE candidates below
        this.setupRemoteStreamListener();

        this.collectCalleeCandidates();

        // Code for creating SDP answer below
        console.log('Got offer:', joinOffer);
        await this.peerConnection.setRemoteDescription(new RTCSessionDescription(joinOffer));
        const answer = await this.peerConnection.createAnswer();
        console.log('Created answer:', answer);
        await this.peerConnection.setLocalDescription(answer);

        const roomAnswer = {
          answer: {
            type: answer.type,
            sdp: answer.sdp,
          },
        };

        await updateDoc(doc(this.firestore, 'rooms', this.roomId), roomAnswer)
        .then((room: any) => {
          console.log(`updated room with SDP answer. Room ID: ${this.roomId}`);
          this.currentRoom = `Current room is ${this.roomId} - You are the callee!`;
        })
        .catch(error => {
          console.error("Error joining room: ", error);
        });

        // Listen for remote ICE candidates below
        const queryCallerCandidates = query(collection(this.firestore, 'rooms', this.roomId, 'callerCandidates'), where("sdpMid", ">=", "0"));
        onSnapshot(queryCallerCandidates, (snapshot) => {
          snapshot.docChanges().forEach(async (change: { type: string; doc: { data: () => any; }; }) => {
            if (change.type === 'added') {
              let data = change.doc.data();
              console.log("Got new remote ICE candidate: ", data);
              await this.peerConnection.addIceCandidate(new RTCIceCandidate(data));
            }
          });
        });
      }
  }

  async hangUp() {

    this.localStream.getTracks().forEach(track => {
      track.stop();
    });
 
    if (this.remoteStream) {
      this.remoteStream.getTracks().forEach(track => track.stop());
      if(this.remoteVideo.nativeElement.srcObject){
        (this.remoteVideo.nativeElement.srcObject as MediaStream).getVideoTracks()[0].stop();
        this.remoteVideo.nativeElement.srcObject = null;
      }
    }
  
    if (this.peerConnection) {
      this.deregisterPeerConnectionListeners();
      this.peerConnection.close();
    }
  
    this.closeUserMedia();
    this.deleteCreatedRoom();
  
    this.hasCreatedRoom.set(false);
    this.hasJoinedRoom.set(false);
    this.showJoinRoomForm.set(false);
    this.currentRoom = '';
    this.roomId = '';
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

  collectCalleeCandidates(){
    const calleeCandidatesCollection = collection(this.firestore, 'rooms', this.roomId, 'calleeCandidates');
      
    this.peerConnection.addEventListener('icecandidate', async event => {
      if (!event.candidate) {
        console.log('Got final candidate!');
        return;
      }
      console.log('Got candidate: ', event.candidate);
      await addDoc(calleeCandidatesCollection, event.candidate.toJSON());
    });
  }

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
      console.log(`ICE connection state change: ${this.peerConnection.iceConnectionState}`);
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

  async deleteCreatedRoom() {
    if (this.hasCreatedRoom()) {
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
        console.error("No CalleeCandidates to delete.", error);
      });

      await deleteDoc(doc(this.firestore, 'rooms', this.roomId));
    }
  };

  setupRemoteStreamListener() {
    let isRemoteVideoPlaying = false;
    this.peerConnection.addEventListener('track', async event => {
      console.log('Got remote track:', event.streams[0]);
      event.streams[0].getTracks().forEach(track => {
        if(this.remoteStream.getTrackById(track.id)){
          console.log('Track already in remoteStream:', track);
          isRemoteVideoPlaying = true;
        }else {
          console.log('Adding track to the remoteStream:', track);
          this.remoteStream.addTrack(track);
        }
      });

      if(!isRemoteVideoPlaying){
        console.log("Adding Remote Video", this.remoteStream);
        this.remoteVideo.nativeElement.srcObject = this.remoteStream;
        await this.remoteVideo.nativeElement.play();
      }
    });
  };

}
