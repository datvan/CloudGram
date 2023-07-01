import PropTypes from 'prop-types';

function Folder(props) {
    const { key, name } = props
    return <div key={key}>
        <h1>{name}<span>(Folder)</span></h1>
    </div>
}

Folder.propTypes = {
    key: PropTypes.string,
    name: PropTypes.string
}

export default Folder