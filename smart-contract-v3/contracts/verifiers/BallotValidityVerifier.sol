// SPDX-License-Identifier: GPL-3.0
/*
    Copyright 2021 0KIMS association.

    This file is generated with [snarkJS](https://github.com/iden3/snarkjs).

    snarkJS is a free software: you can redistribute it and/or modify it
    under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    snarkJS is distributed in the hope that it will be useful, but WITHOUT
    ANY WARRANTY; without even the implied warranty of MERCHANTABILITY
    or FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public
    License for more details.

    You should have received a copy of the GNU General Public License
    along with snarkJS. If not, see <https://www.gnu.org/licenses/>.
*/

pragma solidity >=0.7.0 <0.9.0;

contract Groth16Verifier {
    // Scalar field size
    uint256 constant r    = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    // Base field size
    uint256 constant q   = 21888242871839275222246405745257275088696311157297823662689037894645226208583;

    // Verification Key data
    uint256 constant alphax  = 16428432848801857252194528405604668803277877773566238944394625302971855135431;
    uint256 constant alphay  = 16846502678714586896801519656441059708016666274385668027902869494772365009666;
    uint256 constant betax1  = 3182164110458002340215786955198810119980427837186618912744689678939861918171;
    uint256 constant betax2  = 16348171800823588416173124589066524623406261996681292662100840445103873053252;
    uint256 constant betay1  = 4920802715848186258981584729175884379674325733638798907835771393452862684714;
    uint256 constant betay2  = 19687132236965066906216944365591810874384658708175106803089633851114028275753;
    uint256 constant gammax1 = 11559732032986387107991004021392285783925812861821192530917403151452391805634;
    uint256 constant gammax2 = 10857046999023057135944570762232829481370756359578518086990519993285655852781;
    uint256 constant gammay1 = 4082367875863433681332203403145435568316851327593401208105741076214120093531;
    uint256 constant gammay2 = 8495653923123431417604973247489272438418190587263600148770280649306958101930;
    uint256 constant deltax1 = 15835824034452120192501720730284437981388695652964173852015151584661732254213;
    uint256 constant deltax2 = 9534795569287890085142755506067851035972241047802494327841173436078785619093;
    uint256 constant deltay1 = 13235702830741194736215587118762393598788361951862891469148341888854034077375;
    uint256 constant deltay2 = 1319201516044656517313906354934624436957981777300307512282238223604065298757;

    
    uint256 constant IC0x = 10585503000221069776177052817484379453932825946046417983097841712924987153205;
    uint256 constant IC0y = 454183698514407916724604573539831992936569784472109488519659517027793788654;
    
    uint256 constant IC1x = 4220873449368225039432424169096189470265080019800759644445251393876571957946;
    uint256 constant IC1y = 7055200287302262403504550640734554953392673038476474558385450367571661736670;
    
    uint256 constant IC2x = 4434542747013979824673751878166262594114613728228477989112770463028489921606;
    uint256 constant IC2y = 2460724081173623803533621244909281033450261180991633432870004876167942696795;
    
    uint256 constant IC3x = 18557144795546569513439910811085252363598954836132936598833420285004774745886;
    uint256 constant IC3y = 10346661953811629750860304018759970332744877356314291599548885173014058237849;
    
    uint256 constant IC4x = 4855415738872915327485294072368216421179050208095102217232612821766056021978;
    uint256 constant IC4y = 8321391740098696586919243371573893623202008480035962443306407486164645176019;
    
    uint256 constant IC5x = 5798564282332751241027670571303719451508422235181297914313035303140805596155;
    uint256 constant IC5y = 13989386341046056468118969680847261578380098583721437046432557104029349513006;
    
    uint256 constant IC6x = 10598603619976192607415162585679935613591353916866322265476977220575444290885;
    uint256 constant IC6y = 5470473298561971940732230301103320556917111702509386381868667228673966998514;
    
    uint256 constant IC7x = 13691056425670683457716746621894412582647691050329382337567530978362912489282;
    uint256 constant IC7y = 19983475203194764794262792351431767834325291182251719576064392738132239045908;
    
    uint256 constant IC8x = 3162658601799822512780511445366077336154270600152164001593412621809847159729;
    uint256 constant IC8y = 19887985973749445270988946232007097370487113449931712737366659074519468547569;
    
    uint256 constant IC9x = 16901076248667963193076170865682493559447744079368319184911902816497675420231;
    uint256 constant IC9y = 8407300188842077073427922178797912345932550514880366387413314871956937820649;
    
    uint256 constant IC10x = 14569893362168720409880067710191296379008545712837418349945900970027487945314;
    uint256 constant IC10y = 20508372725347383768023399951004739872197942863369611540558255509168516016634;
    
    uint256 constant IC11x = 9245058404316901945134287391009822384758190114596561074383984263407830159844;
    uint256 constant IC11y = 13315936007959440120517013432509495005331390009779730784945435129190461316425;
    
    uint256 constant IC12x = 11887147165402627936254307611971281790097828474656350596368118396776588164844;
    uint256 constant IC12y = 20581124544216403434919874825232542886431821606502622220987998749516085744153;
    
    uint256 constant IC13x = 4423649657056316851821306743000441626429305175103536425529220245572062591176;
    uint256 constant IC13y = 8335116724025250536175300216781270578860974053570696825123492053499144629020;
    
    uint256 constant IC14x = 4625756687093282915611062790603574331223074746420673221052595276202664243432;
    uint256 constant IC14y = 21563959771839440551473762070880585488178829324208101751795818866323964419331;
    
    uint256 constant IC15x = 1581181270549826846072352295835618744911477760946525435393416667755320407150;
    uint256 constant IC15y = 17033304796803791829679000081499515829840416885880468449203439959402757442084;
    
    uint256 constant IC16x = 19335311522032466718561527290515077268022548128611493264345805700201578798681;
    uint256 constant IC16y = 3706667080845957234554684651107835227616456133308610212273068861708520818832;
    
    uint256 constant IC17x = 17323684516762107502234235000144417950525874259781258554202070153472635947676;
    uint256 constant IC17y = 10753225224691234555961110812682932437374317899083276321628997440225864418937;
    
    uint256 constant IC18x = 5471648850282622035409643504570669845503107245008367838238608592910715851644;
    uint256 constant IC18y = 20887407814824947854305298371288984860795632456466946894458907283258518802752;
    
    uint256 constant IC19x = 3463942182675588142730757213535810399663316642797608833974656530293297407035;
    uint256 constant IC19y = 19535617282979044431102248958328122408444547309224151820651257674206017206371;
    
    uint256 constant IC20x = 18137916775083134829505029136642043276768658519810599793821099835763668946472;
    uint256 constant IC20y = 19669944233246897359920286228662836967851585193828999714002057879561924493185;
    
    uint256 constant IC21x = 4266807444395268840440957729439747978440033759637478419202240985900983772736;
    uint256 constant IC21y = 10614150581471064847877827008055766637600349420599299553701702664225899152462;
    
    uint256 constant IC22x = 20066824189954136607363966165560740500755064466976757855447285845104560289420;
    uint256 constant IC22y = 19924392722562206666524378624189835423667925754088499183852223295711178233787;
    
    uint256 constant IC23x = 11783838300420127037383081454084617024582467173390071880807821485621020236021;
    uint256 constant IC23y = 6124015207988804400479533778980532060294106589397412196018839193590221561461;
    
    uint256 constant IC24x = 5534984774972476994726277445555779763273773622253405932697217564746831494319;
    uint256 constant IC24y = 6382107153715461608661172118809560333465372626625174811717499350057968531782;
    
    uint256 constant IC25x = 17970532419188371201093118082206270248248999346060750455050554278470055320015;
    uint256 constant IC25y = 19630873224404330042157226095125935904240015132547835099714229685632005572801;
    
    uint256 constant IC26x = 6416684237158486077284172624425779631598304067359732434907794587912889834189;
    uint256 constant IC26y = 6736526299644070778972447823867009594595396242336724328857519096247801716344;
    
    uint256 constant IC27x = 9433254339677469263005575568516359268188526606189974256615633741797561450373;
    uint256 constant IC27y = 20073106544539462635272893123188623200224058354907306083266674412748241591421;
    
    uint256 constant IC28x = 10088272850847071129789550567825506557207910645962928777911720353789198053151;
    uint256 constant IC28y = 18577801299683583646887708090136162430529114839894060226856249917265269228774;
    
    uint256 constant IC29x = 21749504171660682078551665211710284927056497341057265725581300198151987834962;
    uint256 constant IC29y = 6002860924054700967750258236189424279109160911785214005462039697530704543275;
    
    uint256 constant IC30x = 10026722106329342672398828234629048967601988957550359866671804077349584983814;
    uint256 constant IC30y = 15284649260595266796992439241410700989495465185288233101737146810839771694924;
    
    uint256 constant IC31x = 20273007572388615807799638271228733110647124826294830545996823578263853821334;
    uint256 constant IC31y = 15534712498150620739691260675883761590654410839547494751524098648282115231363;
    
    uint256 constant IC32x = 7107896081672682633469793715629785806097912214659419394625485010790862865827;
    uint256 constant IC32y = 1358232633538765156881876062692069668251000528599226855076357383285466006950;
    
    uint256 constant IC33x = 16460623740330926489074552254082428032698338677898523595892447325346702714869;
    uint256 constant IC33y = 19080974449646818357537793913165245293578787233926992574165568561273114842199;
    
    uint256 constant IC34x = 3310220458212759782555721930675382459489277786254415744133233121353770432535;
    uint256 constant IC34y = 16884670695932090812833044847778504464944946968446434406069352945930455975660;
    
    uint256 constant IC35x = 9817731638368936972293952116647178396893830306134601607533730311751639647000;
    uint256 constant IC35y = 14659533958201571064116063526033463486666583135781083223536794408085269816083;
    
    uint256 constant IC36x = 21749925761348735712873715129606242082004960208819258616586193678458926799635;
    uint256 constant IC36y = 6284076731967116152600790049607697487644421294086400940548908775216424691307;
    
    uint256 constant IC37x = 10996893959037851022936828738579358130502871451419274241605676649782390986609;
    uint256 constant IC37y = 3391048477341170787108656827041651831681585446321229203540448388629969381377;
    
    uint256 constant IC38x = 2558206069703135972762810726101773680659697404353476675373756580129895456243;
    uint256 constant IC38y = 16760594190992765607254661315355666627972326225844019985211663662605103632521;
    
    uint256 constant IC39x = 1608597892809486843107754275211432054600201873272704036982931902922970253350;
    uint256 constant IC39y = 8996054383171267607794501798858163871534029641205865532237367220756430600844;
    
    uint256 constant IC40x = 2024284625495949022751676536146719319662011422318925298618846496047046302342;
    uint256 constant IC40y = 16857095595730416071067603679938703188001706760883330627748775490403804480478;
    
    uint256 constant IC41x = 15936987523545716870648667507806929571609644279328489470938635901411980146600;
    uint256 constant IC41y = 4046593845036521394348019345258671751840581245152664583246327949443715650582;
    
    uint256 constant IC42x = 16345175833314659171111838727689682215475016538326694306477734125630185396715;
    uint256 constant IC42y = 1156643039235945608378509690141549604431679549285145926490657203112964182108;
    
    uint256 constant IC43x = 8700559905195532235873699550666687985966184394865975908579282125058059184609;
    uint256 constant IC43y = 15966196151893809342116531196151764505477539134411787077924818657857621938356;
    
    uint256 constant IC44x = 10638989675384143224432028986976149493053867470503360716008882623498149814098;
    uint256 constant IC44y = 9654570662103053772937915244978887328330050034769575333540774375281131297595;
    
    uint256 constant IC45x = 21486322055589017224427787747596983182545705232580611402595286486224213905982;
    uint256 constant IC45y = 9042220086595484545057779900372827491070362192249188476969671846581574490766;
    
    uint256 constant IC46x = 1721911822256506839989034562153629995760917841448590847295287692606918262945;
    uint256 constant IC46y = 13208643388295477969896304837759275343156781071920001276597270755799020982846;
    
    uint256 constant IC47x = 774714153117601074732213599123304796404445379352188877488706410181145826076;
    uint256 constant IC47y = 2286575216730265290761304686142792355534088197415423845015217529221014861611;
    
    uint256 constant IC48x = 20889089008302454174825641777325544410146793648022457106822460617434698686693;
    uint256 constant IC48y = 11611918456448779850107985383314296741927837471316501373889373271017147417853;
    
    uint256 constant IC49x = 14169847594360626684298092721270543793763400978171461497631304591440000045598;
    uint256 constant IC49y = 8533573709175485929761441690050033348763243212020969543840670640849440679062;
    
    uint256 constant IC50x = 5147023642159768571266795646909010120709597123028244463049279055364063894958;
    uint256 constant IC50y = 13996019200032904065753246351248258192120340734761305365337255170950020232097;
    
    uint256 constant IC51x = 20733142621927954961270997445155065880085582083593126280073763462624040238267;
    uint256 constant IC51y = 20017172640871818469538022867626749995902803933464056998774063524620469085183;
    
    uint256 constant IC52x = 16724957801067850099106792444405029054783276268580008338415878620427841523748;
    uint256 constant IC52y = 226082766293220306184633483764490804937881226245671268192997295117649636667;
    
    uint256 constant IC53x = 19332918468284716701829261358573864578849959725006027849841329423290196177221;
    uint256 constant IC53y = 4607125362283278082444508885963636391551664797214839268933245380733905856342;
    
    uint256 constant IC54x = 863383996169527992621040187075383729921618447228963896900866902863534740793;
    uint256 constant IC54y = 8406499098842981574589352838320817006611726480587535379295596968921894352003;
    
    uint256 constant IC55x = 21358315197760122593754172711035586543836864228448954017684482483549134115655;
    uint256 constant IC55y = 7528845520678321708557569731257249248337740592686122240881257351898283604637;
    
    uint256 constant IC56x = 8588401276663573710795183493796873191739326214300404119628282170533568516940;
    uint256 constant IC56y = 5407680864138024794174514918051222484138273218321873413858423242417808006823;
    
    uint256 constant IC57x = 3757248298973627429495667833708809371910390640307468651407716976250966700927;
    uint256 constant IC57y = 20450616245203795398448716383952005653487353294398323437864630775740688805558;
    
    uint256 constant IC58x = 10849179170503574817571980093618332121409091770274703033251067098180811440216;
    uint256 constant IC58y = 3112934334407569161972309367829943555964993015843488878110771809269867184114;
    
    uint256 constant IC59x = 2348936458430513865196894546910891128951101184139481784474477267852194674670;
    uint256 constant IC59y = 5585236969399299541068740340327311534229096627718497615033681224095093212057;
    
    uint256 constant IC60x = 17059660523726432395667394797972539935989757592628550938329345873571596320214;
    uint256 constant IC60y = 2832083589382073164914444148072371398257272323818787032275824422505303500677;
    
    uint256 constant IC61x = 8245259104595436180463380165515366907041578014588393882251979649006688319195;
    uint256 constant IC61y = 20378391052706374739032897399473513497010895228004631546884673447426463010303;
    
    uint256 constant IC62x = 16049544662005655414438794607347645468197814380764808096492568269047559160686;
    uint256 constant IC62y = 5876610061883748066138516578602189131173174178150423215587822145340038931216;
    
    uint256 constant IC63x = 395364793124410094692500496403480982531333343199937559803549082338383209740;
    uint256 constant IC63y = 6992206046126973937766482695548272183976338682918734301439264025805230193456;
    
    uint256 constant IC64x = 18514860445375697931081183610180005192512589299475592419191783358228031277309;
    uint256 constant IC64y = 6960782674711766262789142796624637462925336566064811326378305580147651056440;
    
    uint256 constant IC65x = 9732260254262572679816693452830019353945918214286545653811367880746718420273;
    uint256 constant IC65y = 10923675401194031183157348945947771287337841748420718973210137658695236836855;
    
    uint256 constant IC66x = 170680986596982560921584849762161600631861123104838235600283586592535941646;
    uint256 constant IC66y = 8344628825599567331451177583194881785383374228268868040144167104196750002845;
    
    uint256 constant IC67x = 17430958678047583104675460797415051167469564140998484535144953406734212998332;
    uint256 constant IC67y = 11286975628012690329115470219339403655913694278051239419569430710077656307203;
    
    uint256 constant IC68x = 18686858469684570265008297872905098362193408622962013884113512331970517061768;
    uint256 constant IC68y = 20826145680455480071008620188986650109779453961415418551599898428192833884066;
    
 
    // Memory data
    uint16 constant pVk = 0;
    uint16 constant pPairing = 128;

    uint16 constant pLastMem = 896;

    function verifyProof(uint[2] calldata _pA, uint[2][2] calldata _pB, uint[2] calldata _pC, uint[68] calldata _pubSignals) public view returns (bool) {
        assembly {
            function checkField(v) {
                if iszero(lt(v, r)) {
                    mstore(0, 0)
                    return(0, 0x20)
                }
            }
            
            // G1 function to multiply a G1 value(x,y) to value in an address
            function g1_mulAccC(pR, x, y, s) {
                let success
                let mIn := mload(0x40)
                mstore(mIn, x)
                mstore(add(mIn, 32), y)
                mstore(add(mIn, 64), s)

                success := staticcall(sub(gas(), 2000), 7, mIn, 96, mIn, 64)

                if iszero(success) {
                    mstore(0, 0)
                    return(0, 0x20)
                }

                mstore(add(mIn, 64), mload(pR))
                mstore(add(mIn, 96), mload(add(pR, 32)))

                success := staticcall(sub(gas(), 2000), 6, mIn, 128, pR, 64)

                if iszero(success) {
                    mstore(0, 0)
                    return(0, 0x20)
                }
            }

            function checkPairing(pA, pB, pC, pubSignals, pMem) -> isOk {
                let _pPairing := add(pMem, pPairing)
                let _pVk := add(pMem, pVk)

                mstore(_pVk, IC0x)
                mstore(add(_pVk, 32), IC0y)

                // Compute the linear combination vk_x
                
                g1_mulAccC(_pVk, IC1x, IC1y, calldataload(add(pubSignals, 0)))
                
                g1_mulAccC(_pVk, IC2x, IC2y, calldataload(add(pubSignals, 32)))
                
                g1_mulAccC(_pVk, IC3x, IC3y, calldataload(add(pubSignals, 64)))
                
                g1_mulAccC(_pVk, IC4x, IC4y, calldataload(add(pubSignals, 96)))
                
                g1_mulAccC(_pVk, IC5x, IC5y, calldataload(add(pubSignals, 128)))
                
                g1_mulAccC(_pVk, IC6x, IC6y, calldataload(add(pubSignals, 160)))
                
                g1_mulAccC(_pVk, IC7x, IC7y, calldataload(add(pubSignals, 192)))
                
                g1_mulAccC(_pVk, IC8x, IC8y, calldataload(add(pubSignals, 224)))
                
                g1_mulAccC(_pVk, IC9x, IC9y, calldataload(add(pubSignals, 256)))
                
                g1_mulAccC(_pVk, IC10x, IC10y, calldataload(add(pubSignals, 288)))
                
                g1_mulAccC(_pVk, IC11x, IC11y, calldataload(add(pubSignals, 320)))
                
                g1_mulAccC(_pVk, IC12x, IC12y, calldataload(add(pubSignals, 352)))
                
                g1_mulAccC(_pVk, IC13x, IC13y, calldataload(add(pubSignals, 384)))
                
                g1_mulAccC(_pVk, IC14x, IC14y, calldataload(add(pubSignals, 416)))
                
                g1_mulAccC(_pVk, IC15x, IC15y, calldataload(add(pubSignals, 448)))
                
                g1_mulAccC(_pVk, IC16x, IC16y, calldataload(add(pubSignals, 480)))
                
                g1_mulAccC(_pVk, IC17x, IC17y, calldataload(add(pubSignals, 512)))
                
                g1_mulAccC(_pVk, IC18x, IC18y, calldataload(add(pubSignals, 544)))
                
                g1_mulAccC(_pVk, IC19x, IC19y, calldataload(add(pubSignals, 576)))
                
                g1_mulAccC(_pVk, IC20x, IC20y, calldataload(add(pubSignals, 608)))
                
                g1_mulAccC(_pVk, IC21x, IC21y, calldataload(add(pubSignals, 640)))
                
                g1_mulAccC(_pVk, IC22x, IC22y, calldataload(add(pubSignals, 672)))
                
                g1_mulAccC(_pVk, IC23x, IC23y, calldataload(add(pubSignals, 704)))
                
                g1_mulAccC(_pVk, IC24x, IC24y, calldataload(add(pubSignals, 736)))
                
                g1_mulAccC(_pVk, IC25x, IC25y, calldataload(add(pubSignals, 768)))
                
                g1_mulAccC(_pVk, IC26x, IC26y, calldataload(add(pubSignals, 800)))
                
                g1_mulAccC(_pVk, IC27x, IC27y, calldataload(add(pubSignals, 832)))
                
                g1_mulAccC(_pVk, IC28x, IC28y, calldataload(add(pubSignals, 864)))
                
                g1_mulAccC(_pVk, IC29x, IC29y, calldataload(add(pubSignals, 896)))
                
                g1_mulAccC(_pVk, IC30x, IC30y, calldataload(add(pubSignals, 928)))
                
                g1_mulAccC(_pVk, IC31x, IC31y, calldataload(add(pubSignals, 960)))
                
                g1_mulAccC(_pVk, IC32x, IC32y, calldataload(add(pubSignals, 992)))
                
                g1_mulAccC(_pVk, IC33x, IC33y, calldataload(add(pubSignals, 1024)))
                
                g1_mulAccC(_pVk, IC34x, IC34y, calldataload(add(pubSignals, 1056)))
                
                g1_mulAccC(_pVk, IC35x, IC35y, calldataload(add(pubSignals, 1088)))
                
                g1_mulAccC(_pVk, IC36x, IC36y, calldataload(add(pubSignals, 1120)))
                
                g1_mulAccC(_pVk, IC37x, IC37y, calldataload(add(pubSignals, 1152)))
                
                g1_mulAccC(_pVk, IC38x, IC38y, calldataload(add(pubSignals, 1184)))
                
                g1_mulAccC(_pVk, IC39x, IC39y, calldataload(add(pubSignals, 1216)))
                
                g1_mulAccC(_pVk, IC40x, IC40y, calldataload(add(pubSignals, 1248)))
                
                g1_mulAccC(_pVk, IC41x, IC41y, calldataload(add(pubSignals, 1280)))
                
                g1_mulAccC(_pVk, IC42x, IC42y, calldataload(add(pubSignals, 1312)))
                
                g1_mulAccC(_pVk, IC43x, IC43y, calldataload(add(pubSignals, 1344)))
                
                g1_mulAccC(_pVk, IC44x, IC44y, calldataload(add(pubSignals, 1376)))
                
                g1_mulAccC(_pVk, IC45x, IC45y, calldataload(add(pubSignals, 1408)))
                
                g1_mulAccC(_pVk, IC46x, IC46y, calldataload(add(pubSignals, 1440)))
                
                g1_mulAccC(_pVk, IC47x, IC47y, calldataload(add(pubSignals, 1472)))
                
                g1_mulAccC(_pVk, IC48x, IC48y, calldataload(add(pubSignals, 1504)))
                
                g1_mulAccC(_pVk, IC49x, IC49y, calldataload(add(pubSignals, 1536)))
                
                g1_mulAccC(_pVk, IC50x, IC50y, calldataload(add(pubSignals, 1568)))
                
                g1_mulAccC(_pVk, IC51x, IC51y, calldataload(add(pubSignals, 1600)))
                
                g1_mulAccC(_pVk, IC52x, IC52y, calldataload(add(pubSignals, 1632)))
                
                g1_mulAccC(_pVk, IC53x, IC53y, calldataload(add(pubSignals, 1664)))
                
                g1_mulAccC(_pVk, IC54x, IC54y, calldataload(add(pubSignals, 1696)))
                
                g1_mulAccC(_pVk, IC55x, IC55y, calldataload(add(pubSignals, 1728)))
                
                g1_mulAccC(_pVk, IC56x, IC56y, calldataload(add(pubSignals, 1760)))
                
                g1_mulAccC(_pVk, IC57x, IC57y, calldataload(add(pubSignals, 1792)))
                
                g1_mulAccC(_pVk, IC58x, IC58y, calldataload(add(pubSignals, 1824)))
                
                g1_mulAccC(_pVk, IC59x, IC59y, calldataload(add(pubSignals, 1856)))
                
                g1_mulAccC(_pVk, IC60x, IC60y, calldataload(add(pubSignals, 1888)))
                
                g1_mulAccC(_pVk, IC61x, IC61y, calldataload(add(pubSignals, 1920)))
                
                g1_mulAccC(_pVk, IC62x, IC62y, calldataload(add(pubSignals, 1952)))
                
                g1_mulAccC(_pVk, IC63x, IC63y, calldataload(add(pubSignals, 1984)))
                
                g1_mulAccC(_pVk, IC64x, IC64y, calldataload(add(pubSignals, 2016)))
                
                g1_mulAccC(_pVk, IC65x, IC65y, calldataload(add(pubSignals, 2048)))
                
                g1_mulAccC(_pVk, IC66x, IC66y, calldataload(add(pubSignals, 2080)))
                
                g1_mulAccC(_pVk, IC67x, IC67y, calldataload(add(pubSignals, 2112)))
                
                g1_mulAccC(_pVk, IC68x, IC68y, calldataload(add(pubSignals, 2144)))
                

                // -A
                mstore(_pPairing, calldataload(pA))
                mstore(add(_pPairing, 32), mod(sub(q, calldataload(add(pA, 32))), q))

                // B
                mstore(add(_pPairing, 64), calldataload(pB))
                mstore(add(_pPairing, 96), calldataload(add(pB, 32)))
                mstore(add(_pPairing, 128), calldataload(add(pB, 64)))
                mstore(add(_pPairing, 160), calldataload(add(pB, 96)))

                // alpha1
                mstore(add(_pPairing, 192), alphax)
                mstore(add(_pPairing, 224), alphay)

                // beta2
                mstore(add(_pPairing, 256), betax1)
                mstore(add(_pPairing, 288), betax2)
                mstore(add(_pPairing, 320), betay1)
                mstore(add(_pPairing, 352), betay2)

                // vk_x
                mstore(add(_pPairing, 384), mload(add(pMem, pVk)))
                mstore(add(_pPairing, 416), mload(add(pMem, add(pVk, 32))))


                // gamma2
                mstore(add(_pPairing, 448), gammax1)
                mstore(add(_pPairing, 480), gammax2)
                mstore(add(_pPairing, 512), gammay1)
                mstore(add(_pPairing, 544), gammay2)

                // C
                mstore(add(_pPairing, 576), calldataload(pC))
                mstore(add(_pPairing, 608), calldataload(add(pC, 32)))

                // delta2
                mstore(add(_pPairing, 640), deltax1)
                mstore(add(_pPairing, 672), deltax2)
                mstore(add(_pPairing, 704), deltay1)
                mstore(add(_pPairing, 736), deltay2)


                let success := staticcall(sub(gas(), 2000), 8, _pPairing, 768, _pPairing, 0x20)

                isOk := and(success, mload(_pPairing))
            }

            let pMem := mload(0x40)
            mstore(0x40, add(pMem, pLastMem))

            // Validate that all evaluations ∈ F
            
            checkField(calldataload(add(_pubSignals, 0)))
            
            checkField(calldataload(add(_pubSignals, 32)))
            
            checkField(calldataload(add(_pubSignals, 64)))
            
            checkField(calldataload(add(_pubSignals, 96)))
            
            checkField(calldataload(add(_pubSignals, 128)))
            
            checkField(calldataload(add(_pubSignals, 160)))
            
            checkField(calldataload(add(_pubSignals, 192)))
            
            checkField(calldataload(add(_pubSignals, 224)))
            
            checkField(calldataload(add(_pubSignals, 256)))
            
            checkField(calldataload(add(_pubSignals, 288)))
            
            checkField(calldataload(add(_pubSignals, 320)))
            
            checkField(calldataload(add(_pubSignals, 352)))
            
            checkField(calldataload(add(_pubSignals, 384)))
            
            checkField(calldataload(add(_pubSignals, 416)))
            
            checkField(calldataload(add(_pubSignals, 448)))
            
            checkField(calldataload(add(_pubSignals, 480)))
            
            checkField(calldataload(add(_pubSignals, 512)))
            
            checkField(calldataload(add(_pubSignals, 544)))
            
            checkField(calldataload(add(_pubSignals, 576)))
            
            checkField(calldataload(add(_pubSignals, 608)))
            
            checkField(calldataload(add(_pubSignals, 640)))
            
            checkField(calldataload(add(_pubSignals, 672)))
            
            checkField(calldataload(add(_pubSignals, 704)))
            
            checkField(calldataload(add(_pubSignals, 736)))
            
            checkField(calldataload(add(_pubSignals, 768)))
            
            checkField(calldataload(add(_pubSignals, 800)))
            
            checkField(calldataload(add(_pubSignals, 832)))
            
            checkField(calldataload(add(_pubSignals, 864)))
            
            checkField(calldataload(add(_pubSignals, 896)))
            
            checkField(calldataload(add(_pubSignals, 928)))
            
            checkField(calldataload(add(_pubSignals, 960)))
            
            checkField(calldataload(add(_pubSignals, 992)))
            
            checkField(calldataload(add(_pubSignals, 1024)))
            
            checkField(calldataload(add(_pubSignals, 1056)))
            
            checkField(calldataload(add(_pubSignals, 1088)))
            
            checkField(calldataload(add(_pubSignals, 1120)))
            
            checkField(calldataload(add(_pubSignals, 1152)))
            
            checkField(calldataload(add(_pubSignals, 1184)))
            
            checkField(calldataload(add(_pubSignals, 1216)))
            
            checkField(calldataload(add(_pubSignals, 1248)))
            
            checkField(calldataload(add(_pubSignals, 1280)))
            
            checkField(calldataload(add(_pubSignals, 1312)))
            
            checkField(calldataload(add(_pubSignals, 1344)))
            
            checkField(calldataload(add(_pubSignals, 1376)))
            
            checkField(calldataload(add(_pubSignals, 1408)))
            
            checkField(calldataload(add(_pubSignals, 1440)))
            
            checkField(calldataload(add(_pubSignals, 1472)))
            
            checkField(calldataload(add(_pubSignals, 1504)))
            
            checkField(calldataload(add(_pubSignals, 1536)))
            
            checkField(calldataload(add(_pubSignals, 1568)))
            
            checkField(calldataload(add(_pubSignals, 1600)))
            
            checkField(calldataload(add(_pubSignals, 1632)))
            
            checkField(calldataload(add(_pubSignals, 1664)))
            
            checkField(calldataload(add(_pubSignals, 1696)))
            
            checkField(calldataload(add(_pubSignals, 1728)))
            
            checkField(calldataload(add(_pubSignals, 1760)))
            
            checkField(calldataload(add(_pubSignals, 1792)))
            
            checkField(calldataload(add(_pubSignals, 1824)))
            
            checkField(calldataload(add(_pubSignals, 1856)))
            
            checkField(calldataload(add(_pubSignals, 1888)))
            
            checkField(calldataload(add(_pubSignals, 1920)))
            
            checkField(calldataload(add(_pubSignals, 1952)))
            
            checkField(calldataload(add(_pubSignals, 1984)))
            
            checkField(calldataload(add(_pubSignals, 2016)))
            
            checkField(calldataload(add(_pubSignals, 2048)))
            
            checkField(calldataload(add(_pubSignals, 2080)))
            
            checkField(calldataload(add(_pubSignals, 2112)))
            
            checkField(calldataload(add(_pubSignals, 2144)))
            

            // Validate all evaluations
            let isValid := checkPairing(_pA, _pB, _pC, _pubSignals, pMem)

            mstore(0, isValid)
             return(0, 0x20)
         }
     }
 }
